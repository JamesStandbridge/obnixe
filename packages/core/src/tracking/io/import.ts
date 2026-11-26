import { and, between, eq, isNull } from "drizzle-orm";
import { recording, session } from "@obnixe/schema";
import type { EpochMs, FieldValue, FieldValues, Id } from "@obnixe/schema";
import { sportOf } from "../../activity/catalog.ts";
import { weighInBefore } from "../../body/weight.ts";
import { importActor } from "../../data/backup/merge.ts";
import { trashMutation } from "../../data/trash.ts";
import type { Environment, ObnixeDatabase } from "../../database.ts";
import { localDateOf } from "../../dates.ts";
import { readSettings } from "../../settings.ts";
import type { CommitRequest, Mutation } from "../../writer.ts";
import { activityWindow, processTrack } from "../batch.ts";
import type { ProcessedTrack } from "../batch.ts";
import { encodeTrack, trackDigest, trackFilePath } from "../codec/track.ts";
import type { Track } from "../codec/track.ts";
import { estimateEnergy } from "../energy.ts";
import type { EnergyEstimate } from "../energy.ts";
import { BoundingBoxBuilder } from "../geo.ts";
import { maskTrack } from "../privacy.ts";
import type { TrackPositions } from "../privacy.ts";
import { activePrivacyMask } from "../privacyZones.ts";
import { resolveProfile } from "../profile.ts";
import { cadenceReadings, powerReadings, sensorMeanOver } from "../sensors.ts";
import { previewPolyline } from "../simplify.ts";
import { heartRateMaxBetween, PauseLedger } from "../stages/derive.ts";
import type { LapBounds } from "../stages/derive.ts";
import { importedSummary, sessionValuesFromRecording } from "../summary.ts";
import type { RecordingSummary } from "../summary.ts";
import { noTerrain } from "../types.ts";
import type { TerrainColumns } from "../types.ts";
import { trackingAlgorithmVersion } from "../version.ts";
import { forEachHeartRateSpan, isHeartRateReading } from "../zones.ts";
import type { TimeSpan } from "../zones.ts";
import { importedTrack } from "./activity.ts";
import type { ArchiveFormat, FileFormat, ImportedActivity } from "./activity.ts";
import type { SportGuess } from "./sports.ts";

export const importSummary = "Import d'une activité";
/** Start gap and relative distance gap under which an existing session of the same sport is a probable duplicate (`IO-012`). */
export const duplicateStartMs = 120_000;
export const duplicateDistanceRatio = 0.05;

const formatDevices: Readonly<Record<FileFormat, string>> = { gpx: "Fichier GPX", tcx: "Fichier TCX", fit: "Fichier FIT" };

/** An activity measured by the Obnixe engine (`IO-011`), what the import preview shows and `planImport` writes. */
export interface ImportComputation {
  readonly activity: ImportedActivity;
  readonly sport: SportGuess;
  readonly track: Track;
  /** `null` when the sport records no track or the file has no positions: the summary then holds the file totals. */
  readonly processed: ProcessedTrack | null;
  readonly summary: RecordingSummary;
  readonly elapsed: TimeSpan;
  readonly moving: readonly TimeSpan[];
  readonly laps: readonly LapBounds[];
  readonly values: FieldValues;
  readonly pausedSeconds: number;
}

export type ImportDuplicate =
  | { readonly kind: "none" }
  /** The same file is already in the journal (`recording.external_id`): importing it again replaces that session or nothing. */
  | { readonly kind: "already_imported"; readonly sessionId: Id }
  /** Ignore (default), replace one of them, or keep both (`IO-012`). */
  | { readonly kind: "probable"; readonly sessionIds: readonly Id[] };

export interface ImportDraft {
  readonly computation: ImportComputation;
  readonly timeZone: string;
  /** The session the import replaces (`IO-012` *Remplacer*), moved to the trash in the same changeset. */
  readonly replaceSessionId: Id | null;
  /** The account archive the file comes from (`IO-053`), recorded as `recording.import_format` instead of the file format. */
  readonly archiveFormat?: ArchiveFormat;
}

/** The `.otrk` to write, synced and verified, before committing the request that references it. */
export interface ImportTrackFile {
  readonly path: string;
  readonly bytes: Uint8Array;
  readonly sha256: string;
}

export interface ImportPlan {
  readonly sessionId: Id;
  readonly recordingId: Id;
  readonly track: ImportTrackFile | null;
  readonly request: CommitRequest;
}

export class AlreadyImportedError extends Error {
  constructor(readonly sessionId: Id) {
    super(`The file is already imported as session ${sessionId}`);
  }
}

export class ReplacedSessionNotFoundError extends Error {
  constructor(readonly sessionId: Id) {
    super(`Session ${sessionId} to replace does not exist or is in the trash`);
  }
}

/** `recording.device` of an imported file: the device it names, or its format. */
export function fileDevice(activity: ImportedActivity): string {
  return activity.device ?? formatDevices[activity.format];
}

function fileLaps(activity: ImportedActivity, elapsed: TimeSpan): readonly LapBounds[] {
  const spans = activity.laps.length > 0 ? activity.laps : [elapsed];
  return spans.map((span): LapBounds => ({ trigger: "import", startOffsetMs: span.startMs, endOffsetMs: Math.min(span.endMs, elapsed.endMs), workoutStep: null })).filter((lap) => lap.endOffsetMs > lap.startOffsetMs);
}

const reading = (bpm: number | null): number | null => (bpm !== null && isHeartRateReading(bpm) ? bpm : null);

function heartRateAverage(track: Track, window: TimeSpan): number | null {
  let beats = 0;
  let coveredMs = 0;
  forEachHeartRateSpan(track.samples.heartRate, window, (startMs, endMs, bpm) => {
    beats += bpm * (endMs - startMs);
    coveredMs += endMs - startMs;
  });
  return coveredMs === 0 ? null : Math.round(beats / coveredMs);
}

/** The summary of an import measured without the engine: the file totals, completed from its samples. */
function totalsSummary(activity: ImportedActivity, track: Track, elapsed: TimeSpan, pauses: readonly TimeSpan[]): RecordingSummary {
  const { fixes, steps, heartRate, power } = track.samples;
  const totals = activity.totals;
  const elapsedMs = elapsed.endMs - elapsed.startMs;
  const pausedMs = pauses.reduce((total, span) => total + span.endMs - span.startMs, 0);
  const movingMs = Math.min(Math.max(totals?.timerMs ?? elapsedMs - pausedMs, 0), elapsedMs);
  const stepCount = steps.length === 0 ? null : (steps.count[steps.length - 1] ?? 0);
  const heartRateAvg = reading(totals?.heartRateAvg ?? null) ?? heartRateAverage(track, elapsed);
  const heartRateMax = reading(totals?.heartRateMax ?? null);
  const cadence = cadenceReadings(track.samples);
  const cadenceAvg = cadence === null ? null : sensorMeanOver(cadence, elapsed, "positive");
  const bbox = new BoundingBoxBuilder();
  for (let index = 0; index < fixes.length; index += 1) bbox.include((fixes.latitudeE7[index] ?? 0) / 1e7, (fixes.longitudeE7[index] ?? 0) / 1e7);
  return {
    algorithmVersion: trackingAlgorithmVersion,
    elapsedMs,
    movingMs,
    distanceMm: totals?.distanceMm ?? (activity.pool === null ? 0 : activity.pool.distanceMeters * 1000),
    ascentMm: null,
    descentMm: null,
    altitudeMinMm: null,
    altitudeMaxMm: null,
    speedMaxMmS: null,
    cadenceAvg: cadence !== null ? cadenceAvg : stepCount === null || movingMs <= 0 ? null : Math.round((stepCount * 60_000) / movingMs),
    steps: stepCount,
    heartRateAvg,
    heartRateMax: heartRateMax ?? (heartRate.length === 0 ? null : heartRateMaxBetween(heartRate, elapsed.startMs, elapsed.endMs + 1)),
    powerAvg: totals?.powerAvg ?? (power.length === 0 ? null : sensorMeanOver(powerReadings(power), elapsed, "every")),
    goodFixPermille: fixes.length === 0 ? 0 : 1000,
    bbox: bbox.build(),
    pointCount: fixes.length,
    simulated: false,
    elevationSource: "none",
    cadenceSource: stepCount === null && cadence === null ? "none" : "file",
    heartRateSource: heartRate.length === 0 && heartRateAvg === null ? "none" : "file",
  };
}

function totalsValues(values: FieldValues, summary: RecordingSummary): FieldValues {
  const derived: Record<string, FieldValue> = { ...values, distance: Math.round(summary.distanceMm / 1000) };
  if (summary.heartRateAvg !== null) derived.heart_rate_avg = summary.heartRateAvg;
  if (summary.powerAvg !== null) derived.power_avg = summary.powerAvg;
  return derived;
}

/** The derived values limited to the fields of the sport, with the pool of a lap swim (`IO-050`). */
function importedValues(sport: SportGuess, derived: FieldValues, activity: ImportedActivity): FieldValues {
  const values: Record<string, FieldValue> = { ...derived };
  if (activity.pool !== null) {
    values.water = "pool";
    values.pool_length = activity.pool.poolLengthMeters;
    values.lengths = activity.pool.lengths;
    values.distance = activity.pool.distanceMeters;
  }
  const keys = new Set(sportOf(sport.sport).sessionFields.map((field) => field.key));
  return Object.fromEntries(Object.entries(values).filter(([key]) => keys.has(key)));
}

/**
 * Measures an imported activity as a recorded one (`IO-011`): positions through stages 2 to 9 with the file laps re-measured,
 * the file totals when the sport records no track or the file has no positions. `sport` is the detected sport or the user's
 * choice (`IO-010`).
 */
export function computeImport(activity: ImportedActivity, sport: SportGuess): ImportComputation {
  return measureImport(activity, sport, noTerrain);
}

/** `ELE-003`: an import without altitude measured again on the DEM altitude of its fixes, before it is written. */
export function computeDemImport(computation: ImportComputation, terrain: TerrainColumns): ImportComputation {
  return measureImport(computation.activity, computation.sport, terrain);
}

function measureImport(activity: ImportedActivity, sport: SportGuess, terrain: TerrainColumns): ImportComputation {
  const profile = resolveProfile(sport.sport, sport.values);
  const file = importedTrack(activity, profile?.cadence === "steps");
  const track: Track = { ...file, samples: { ...file.samples, terrain } };
  const trim = { startMs: 0, endMs: null };
  const window = activityWindow(track.samples, track.marks, trim);
  const laps = fileLaps(activity, window);
  if (profile !== null && track.samples.fixes.length > 1) {
    const processed = processTrack(track, profile, { laps: { kind: "given", laps }, trim });
    const summary = importedSummary(processed.summary);
    const update = sessionValuesFromRecording(sport.values, summary, profile);
    return {
      activity,
      sport,
      track,
      processed,
      summary,
      elapsed: processed.elapsed,
      moving: processed.moving,
      laps: processed.laps.map((lap) => lap.bounds),
      values: importedValues(sport, update.values, activity),
      pausedSeconds: update.pausedSeconds,
    };
  }
  const ledger = new PauseLedger();
  for (const mark of track.marks) ledger.mark(mark);
  const pauses = ledger.spans(window);
  const summary = totalsSummary(activity, track, window, pauses);
  const moving: TimeSpan[] = [];
  let from = window.startMs;
  for (const pause of [...pauses, { startMs: window.endMs, endMs: window.endMs }]) {
    if (pause.startMs > from) moving.push({ startMs: from, endMs: pause.startMs });
    from = pause.endMs;
  }
  return {
    activity,
    sport,
    track,
    processed: null,
    summary,
    elapsed: window,
    moving,
    laps,
    values: importedValues(sport, totalsValues(sport.values, summary), activity),
    pausedSeconds: Math.round((summary.elapsedMs - summary.movingMs) / 1000),
  };
}

const distanceOf = (row: { readonly distanceMm: number | null; readonly values: FieldValues }): number | null =>
  row.distanceMm ?? (typeof row.values.distance === "number" ? row.values.distance * 1000 : null);

/** The distance the duplicate rule compares (`IO-012`): the pool distance of a lap swim, the measured one otherwise. */
export function importDistanceMm(computation: ImportComputation): number {
  const { pool } = computation.activity;
  return pool === null ? computation.summary.distanceMm : pool.distanceMeters * 1000;
}

/** Whether a distance is within 5 % of a known one (`IO-012`); a session without distance matches only an activity without one. */
export function withinDuplicateDistance(distanceMm: number, knownMm: number | null): boolean {
  return knownMm === null ? distanceMm === 0 : Math.abs(distanceMm - knownMm) <= duplicateDistanceRatio * knownMm;
}

/** The session in force whose recording holds `externalId`. */
export function importHolder(db: ObnixeDatabase, externalId: string): Id | null {
  const held = db
    .select({ sessionId: session.id })
    .from(recording)
    .innerJoin(session, eq(session.id, recording.sessionId))
    .where(and(eq(recording.externalId, externalId), isNull(session.deletedAt)))
    .get();
  return held?.sessionId ?? null;
}

/** The file already imported, or the sessions of the same sport starting within 120 s with a distance within 5 % (`IO-012`). */
export function findImportDuplicate(db: ObnixeDatabase, computation: ImportComputation): ImportDuplicate {
  const { activity } = computation;
  const held = importHolder(db, activity.externalId);
  if (held !== null) return { kind: "already_imported", sessionId: held };
  const candidates = db
    .select({ id: session.id, values: session.values, distanceMm: recording.distanceMm })
    .from(session)
    .leftJoin(recording, eq(recording.sessionId, session.id))
    .where(and(eq(session.sport, computation.sport.sport), isNull(session.deletedAt), between(session.startedAt, (activity.startedAt - duplicateStartMs) as EpochMs, (activity.startedAt + duplicateStartMs) as EpochMs)))
    .all();
  const distance = importDistanceMm(computation);
  const sessionIds = candidates.filter((candidate) => withinDuplicateDistance(distance, distanceOf(candidate))).map((candidate) => candidate.id);
  return sessionIds.length === 0 ? { kind: "none" } : { kind: "probable", sessionIds };
}

function energyOf(db: ObnixeDatabase, computation: ImportComputation): EnergyEstimate | null {
  const { activity, processed, track } = computation;
  const weighed = weighInBefore(db, activity.startedAt);
  if (weighed === null) return null;
  const { birthYear, sex } = readSettings(db);
  return estimateEnergy(
    {
      sport: computation.sport.sport,
      values: computation.values,
      startedAt: activity.startedAt,
      elapsed: computation.elapsed,
      moving: computation.moving,
      distanceMm: computation.summary.distanceMm,
      path: processed === null ? null : { distance: processed.series.distance, grade: processed.series.grade },
      heartRate: track.samples.heartRate.length === 0 ? null : track.samples.heartRate,
      descents: processed === null ? null : processed.descents.map((descent) => ({ startMs: descent.startMs, endMs: descent.endMs })),
      power: track.samples.power.length === 0 ? null : track.samples.power,
    },
    { massGrams: weighed.grams, birthYear, sex },
  );
}

function previewOf(db: ObnixeDatabase, computation: ImportComputation): string | null {
  const { processed } = computation;
  const { fixes } = computation.track.samples;
  const positions: TrackPositions =
    processed === null
      ? { length: fixes.length, latitude: Float64Array.from(fixes.latitudeE7, (value) => value / 1e7), longitude: Float64Array.from(fixes.longitudeE7, (value) => value / 1e7) }
      : processed.series;
  if (positions.length === 0) return null;
  const mask = activePrivacyMask(db);
  return previewPolyline(positions, maskTrack(positions, mask.zones, mask));
}

function hasSamples(track: Track): boolean {
  const { fixes, pressure, steps, heartRate } = track.samples;
  return fixes.length + pressure.length + steps.length + heartRate.length > 0;
}

/**
 * Frees the file's `external_id` for a new recording: a trashed session or the replaced one gives it up. Throws
 * `AlreadyImportedError` when a live session holds the file and is not the one replaced.
 */
export function externalIdRelease(db: ObnixeDatabase, externalId: string, replaceSessionId: Id | null): readonly Mutation[] {
  const holder = db
    .select({ recordingId: recording.id, sessionId: recording.sessionId, deletedAt: session.deletedAt })
    .from(recording)
    .innerJoin(session, eq(session.id, recording.sessionId))
    .where(eq(recording.externalId, externalId))
    .get();
  if (holder === undefined) return [];
  if (holder.deletedAt === null && holder.sessionId !== replaceSessionId) throw new AlreadyImportedError(holder.sessionId);
  return [{ kind: "update", table: "recording", key: holder.recordingId, patch: { externalId: null } }];
}

/**
 * The changeset of an import (`IO-010`), author `import`: a `completed` session, its `recording` with `source = 'import'`, its
 * laps, and the trace to write first. A replaced session goes to the trash; a trashed session holding the same file gives up
 * its `external_id` (`externalIdRelease`).
 */
export function planImport(db: ObnixeDatabase, env: Environment, draft: ImportDraft): ImportPlan {
  const { computation, timeZone, replaceSessionId } = draft;
  const { activity, summary } = computation;
  const now = env.now();
  if (replaceSessionId !== null) {
    const replaced = db.select({ id: session.id }).from(session).where(and(eq(session.id, replaceSessionId), isNull(session.deletedAt))).get();
    if (replaced === undefined) throw new ReplacedSessionNotFoundError(replaceSessionId);
  }
  const mutations: Mutation[] = [...externalIdRelease(db, activity.externalId, replaceSessionId)];
  if (replaceSessionId !== null) mutations.push(trashMutation("session", replaceSessionId, now));

  const sessionId = env.newId();
  const recordingId = env.newId();
  const bytes = hasSamples(computation.track) ? encodeTrack(computation.track) : null;
  const track = bytes === null ? null : { path: trackFilePath(recordingId), bytes, sha256: trackDigest(bytes) };
  const energy = energyOf(db, computation);
  const device = fileDevice(activity);
  mutations.push(
    {
      kind: "insert",
      table: "session",
      row: {
        id: sessionId,
        sport: computation.sport.sport,
        slotId: null,
        variantId: null,
        countsInRotation: false,
        gearId: null,
        title: activity.name,
        status: "completed",
        startedAt: activity.startedAt,
        endedAt: (activity.startedAt + summary.elapsedMs) as EpochMs,
        pausedSeconds: computation.pausedSeconds,
        localDate: localDateOf(activity.startedAt, timeZone),
        timeZone,
        values: computation.values,
        effort: null,
        sensation: null,
        enjoyment: null,
        note: null,
        review: "pending",
        deletedAt: null,
      },
    },
    {
      kind: "insert",
      table: "recording",
      row: {
        id: recordingId,
        sessionId,
        source: "import",
        importFormat: draft.archiveFormat ?? activity.format,
        externalId: activity.externalId,
        device,
        algorithmVersion: summary.algorithmVersion,
        autoPause: false,
        elevationSource: summary.elevationSource,
        cadenceSource: summary.cadenceSource,
        heartRateSource: summary.heartRateSource,
        simulated: false,
        trimStartMs: 0,
        trimEndMs: null,
        elapsedMs: summary.elapsedMs,
        movingMs: summary.movingMs,
        distanceMm: summary.distanceMm,
        ascentMm: summary.ascentMm,
        descentMm: summary.descentMm,
        altitudeMinMm: summary.altitudeMinMm,
        altitudeMaxMm: summary.altitudeMaxMm,
        speedMaxMmS: summary.speedMaxMmS,
        cadenceAvg: summary.cadenceAvg,
        steps: summary.steps,
        heartRateAvg: summary.heartRateAvg,
        heartRateMax: summary.heartRateMax,
        heartRateDevice: summary.heartRateSource === "none" ? null : device,
        cadenceDevice: null,
        powerAvg: summary.powerAvg,
        powerDevice: summary.powerAvg === null ? null : device,
        energyKcal: energy?.kcal ?? null,
        energyMethod: energy?.method ?? null,
        importedEnergyKcal: activity.totals?.energyKcal ?? null,
        weather: null,
        goodFixPermille: summary.goodFixPermille,
        bbox: summary.bbox,
        previewPolyline: previewOf(db, computation),
        trackFile: track?.path ?? null,
        trackSha256: track?.sha256 ?? null,
        trackBytes: track?.bytes.length ?? null,
        pointCount: summary.pointCount,
      },
    },
    ...computation.laps.map((lap, position): Mutation => ({ kind: "insert", table: "lap", row: { id: env.newId(), sessionId, position, ...lap } })),
  );
  return { sessionId, recordingId, track, request: { actor: importActor, summary: importSummary, revertsId: null, mutations } };
}
