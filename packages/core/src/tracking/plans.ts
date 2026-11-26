import { asc, eq } from "drizzle-orm";
import { gear, lap, programSlot, recording, session, sportPreference } from "@obnixe/schema";
import type { EpochMs, FieldValues, Id, Lap, PainLevel, Recording, RecordingSettings, Session, SportKey, ZoneKey } from "@obnixe/schema";
import { sportOf } from "../activity/catalog.ts";
import { OpenSessionExistsError } from "../activity/climb.ts";
import type { SlotLink } from "../activity/freeSession.ts";
import { painReportMutations, trackedZones } from "../activity/pain.ts";
import { weighInBefore } from "../body/weight.ts";
import type { Environment, ObnixeDatabase } from "../database.ts";
import { localDateOf } from "../dates.ts";
import { readSettings } from "../settings.ts";
import { interruptMutations, openSessionRow, resumeMutations, SessionStateError } from "../training/lifecycle.ts";
import type { Mutation, NewRow } from "../writer.ts";
import { activityWindow, processTrack } from "./batch.ts";
import type { ProcessedTrack, TrackTrim } from "./batch.ts";
import type { Track } from "./codec/track.ts";
import { maskedPreview } from "./derived.ts";
import { activePrivacyMask } from "./privacyZones.ts";
import type { PrivacyMask } from "./privacyZones.ts";
import { estimateEnergy } from "./energy.ts";
import type { EnergyEstimate } from "./energy.ts";
import { resolveProfile } from "./profile.ts";
import type { ResolvedProfile } from "./profile.ts";
import { importedSummary, sessionValuesFromRecording } from "./summary.ts";
import type { LapBounds } from "./stages/derive.ts";
import { trackingAlgorithmVersion } from "./version.ts";

export class NotRecordableError extends Error {
  constructor(readonly sport: SportKey) {
    super(`${sport} records no track with these values`);
  }
}

export class NotRecordingError extends Error {
  constructor(readonly sessionId: Id) {
    super(`Session ${sessionId} has no live recording`);
  }
}

/** The sport's recording settings, or the defaults of its profile when none were chosen. */
export function recordingSettingsOf(db: ObnixeDatabase, profile: ResolvedProfile): RecordingSettings {
  const stored = db.select({ settings: sportPreference.recordingSettings }).from(sportPreference).where(eq(sportPreference.sport, profile.sport)).get()?.settings ?? null;
  return stored ?? defaultRecordingSettings(profile);
}

/** Annex A defaults: every alert on, no sound, no span watched, no heart-rate source. */
export function defaultRecordingSettings(profile: Pick<ResolvedProfile, "autoPauseDefault">): RecordingSettings {
  return { autoPause: profile.autoPauseDefault, autoLap: null, readout: null, alerts: { disabled: [], sound: false, paceRange: null, heartRateRange: null }, heartRateDevice: null };
}

/** Stores the sport's recording settings (`DAT-003`), adding its preference row, disabled, when the sport has none yet. */
export function recordingSettingsMutation(db: ObnixeDatabase, sport: SportKey, settings: RecordingSettings): Mutation {
  const preferences = db.select({ sport: sportPreference.sport }).from(sportPreference).all();
  if (preferences.some((preference) => preference.sport === sport)) return { kind: "update", table: "sport_preference", key: sport, patch: { recordingSettings: settings } };
  return { kind: "insert", table: "sport_preference", row: { sport, enabled: false, position: preferences.length, recordingSettings: settings } };
}

export interface RecordingStartRequest {
  readonly sport: SportKey;
  readonly values: FieldValues;
  readonly gearId: Id | null;
  /** `INT-002`: a recording started from a slot carries it like a free session does. */
  readonly slot: SlotLink | null;
  readonly timeZone: string;
}

export interface RecordingStartPlan {
  readonly sessionId: Id;
  readonly recordingId: Id;
  readonly request: RecordingStartRequest;
  readonly profile: ResolvedProfile;
  readonly settings: RecordingSettings;
}

/** What the journal header says once the native module started: `t0` and the phone model. */
export interface StartedJournal {
  readonly startedAt: EpochMs;
  readonly device: string;
}

/** Checks `REC-003` (one open session at a time) and the profile before the tracker starts, and picks the ids. */
export function planRecordingStart(db: ObnixeDatabase, env: Environment, request: RecordingStartRequest): RecordingStartPlan {
  const open = openSessionRow(db);
  if (open !== null) throw new OpenSessionExistsError(open.id);
  const profile = resolveProfile(request.sport, request.values);
  if (profile === null) throw new NotRecordableError(request.sport);
  return { sessionId: env.newId(), recordingId: env.newId(), request, profile, settings: recordingSettingsOf(db, profile) };
}

/** The « Sortie démarrée » changeset (`INT-030`): the open session and its recording, summarized at the stop. */
export function recordingStartMutations(plan: RecordingStartPlan, started: StartedJournal): readonly Mutation[] {
  const { request } = plan;
  return [
    {
      kind: "insert",
      table: "session",
      row: {
        id: plan.sessionId,
        sport: request.sport,
        slotId: request.slot?.slotId ?? null,
        variantId: request.slot?.variantId ?? null,
        countsInRotation: request.slot?.countsInRotation ?? false,
        gearId: sportOf(request.sport).usesGear ? request.gearId : null,
        title: null,
        status: "in_progress",
        startedAt: started.startedAt,
        endedAt: null,
        pausedSeconds: 0,
        localDate: localDateOf(started.startedAt, request.timeZone),
        timeZone: request.timeZone,
        values: request.values,
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
        id: plan.recordingId,
        sessionId: plan.sessionId,
        source: "live",
        importFormat: null,
        externalId: null,
        device: started.device,
        algorithmVersion: trackingAlgorithmVersion,
        autoPause: plan.settings.autoPause,
        elevationSource: "none",
        cadenceSource: "none",
        heartRateSource: "none",
        simulated: false,
        trimStartMs: 0,
        trimEndMs: null,
        elapsedMs: 0,
        movingMs: 0,
        distanceMm: 0,
        ascentMm: null,
        descentMm: null,
        altitudeMinMm: null,
        altitudeMaxMm: null,
        speedMaxMmS: null,
        cadenceAvg: null,
        steps: null,
        heartRateAvg: null,
        heartRateMax: null,
        heartRateDevice: plan.settings.heartRateDevice?.name ?? null,
        energyKcal: null,
        energyMethod: null,
        importedEnergyKcal: null,
        weather: null,
        goodFixPermille: 0,
        bbox: null,
        previewPolyline: null,
        trackFile: null,
        trackSha256: null,
        trackBytes: null,
        pointCount: 0,
      },
    },
  ];
}

/** A `.otrk` file written and verified before the commit that references it (`DAT-020`). */
export interface StoredTrack {
  readonly file: string;
  readonly sha256: string;
  readonly bytes: number;
}

export class NotMeasuredError extends Error {
  constructor(readonly sessionId: Id) {
    super(`Session ${sessionId} has no completed recording with a track to measure`);
  }
}

export interface SessionRecording {
  readonly session: Session;
  readonly recording: Recording;
}

function sessionRecordingOf(db: ObnixeDatabase, sessionId: Id): SessionRecording | undefined {
  return db.select({ session, recording }).from(session).innerJoin(recording, eq(recording.sessionId, session.id)).where(eq(session.id, sessionId)).get();
}

export function liveRecordingOf(db: ObnixeDatabase, sessionId: Id): SessionRecording {
  const found = sessionRecordingOf(db, sessionId);
  if (found === undefined || found.recording.source !== "live") throw new NotRecordingError(sessionId);
  return found;
}

/** A completed recording, live or imported, with a stored track of positions that the engine measures (`SUM-004`, `SUM-005`). */
export function measuredRecordingOf(db: ObnixeDatabase, sessionId: Id): SessionRecording {
  const found = sessionRecordingOf(db, sessionId);
  if (found === undefined || found.session.status !== "completed" || found.session.deletedAt !== null || found.recording.trackFile === null || found.recording.pointCount < 2) {
    throw new NotMeasuredError(sessionId);
  }
  return found;
}

export function profileOfSession(current: Pick<Session, "id" | "sport" | "values">): ResolvedProfile {
  const profile = resolveProfile(current.sport, current.values);
  if (profile === null) throw new NotRecordableError(current.sport);
  return profile;
}

function energyOf(db: ObnixeDatabase, current: Session, track: Track, processed: ProcessedTrack): EnergyEstimate | null {
  const weighed = weighInBefore(db, current.startedAt);
  if (weighed === null) return null;
  const physiology = readSettings(db);
  return estimateEnergy(
    {
      sport: current.sport,
      values: current.values,
      startedAt: current.startedAt,
      elapsed: processed.elapsed,
      moving: processed.moving,
      distanceMm: processed.summary.distanceMm,
      path: { distance: processed.series.distance, grade: processed.series.grade },
      heartRate: track.samples.heartRate.length > 0 ? track.samples.heartRate : null,
    },
    { massGrams: weighed.grams, birthYear: physiology.birthYear, sex: physiology.sex },
  );
}

type RecordingPatch = Partial<NewRow<"recording">>;

/** The recording columns a processing rewrites: the summary (`DAT-010`), the energy (`CAL-001`) and the masked preview (`PRV-010`). */
function recordingPatchOf(db: ObnixeDatabase, saved: SessionRecording, track: Track, processed: ProcessedTrack, mask: PrivacyMask): RecordingPatch {
  const energy = energyOf(db, saved.session, track, processed);
  return {
    ...(saved.recording.source === "import" ? importedSummary(processed.summary) : processed.summary),
    energyKcal: energy?.kcal ?? null,
    energyMethod: energy?.method ?? null,
    previewPolyline: maskedPreview(processed.series, mask),
  };
}

function lapsOf(db: ObnixeDatabase, sessionId: Id): readonly Lap[] {
  return db.select().from(lap).where(eq(lap.sessionId, sessionId)).orderBy(asc(lap.position)).all();
}

function lapInserts(env: Environment, sessionId: Id, processed: ProcessedTrack): readonly Mutation[] {
  return processed.laps.map(
    (summary, position): Mutation => ({
      kind: "insert",
      table: "lap",
      row: { id: env.newId(), sessionId, position, trigger: summary.bounds.trigger, startOffsetMs: summary.bounds.startOffsetMs, endOffsetMs: summary.bounds.endOffsetMs },
    }),
  );
}

/** The recording updated in place, or moved to the row `recordingId` whose track file is a new one. */
function recordingMutations(live: SessionRecording, patch: RecordingPatch, recordingId: Id): readonly Mutation[] {
  if (recordingId === live.recording.id) return [{ kind: "update", table: "recording", key: recordingId, patch }];
  const { createdAt, updatedAt, ...row } = live.recording;
  return [
    { kind: "delete", table: "recording", key: live.recording.id },
    { kind: "insert", table: "recording", row: { ...row, ...patch, id: recordingId } },
  ];
}

/**
 * Old laps go first so a shorter recording never sees a lap beyond its end; the new ones follow it. The session keeps its
 * start, so a trimmed start counts as paused time and the active time stays the moving time.
 */
function rewrite(
  db: ObnixeDatabase,
  env: Environment,
  live: SessionRecording,
  track: Track,
  processed: ProcessedTrack,
  profile: ResolvedProfile,
  extra: RecordingPatch,
  sessionExtra: Partial<NewRow<"session">>,
  recordingId: Id = live.recording.id,
): readonly Mutation[] {
  const derived = sessionValuesFromRecording(live.session.values, processed.summary, profile);
  return [
    ...lapsOf(db, live.session.id).map((row): Mutation => ({ kind: "delete", table: "lap", key: row.id })),
    ...recordingMutations(live, { ...recordingPatchOf(db, live, track, processed, activePrivacyMask(db)), ...extra }, recordingId),
    { kind: "update", table: "session", key: live.session.id, patch: { values: derived.values, pausedSeconds: derived.pausedSeconds + Math.round(processed.elapsed.startMs / 1000), ...sessionExtra } },
    ...lapInserts(env, live.session.id, processed),
  ];
}

function endOf(live: SessionRecording, track: Track, processed: ProcessedTrack): EpochMs {
  return Math.max(track.startedAt + processed.elapsed.endMs, live.session.startedAt) as EpochMs;
}

export interface RecordingSaveInput {
  readonly sessionId: Id;
  readonly track: Track;
  /** `processTrack` of `track` with the recorded laps and no trim, as shown by the stop summary. */
  readonly processed: ProcessedTrack;
  readonly stored: StoredTrack;
  /** `INT-020`: pains signalled from the live screen, oldest first. */
  readonly pains: readonly ActivityPain[];
}

/** A pain signalled during the activity, in two touches: a zone of the sport, then its level. */
export interface ActivityPain {
  readonly zone: ZoneKey;
  readonly level: Exclude<PainLevel, "none">;
  readonly occurredAt: EpochMs;
}

/**
 * The « Sortie de 12,3 km » changeset (`INT-030`, `DAT-010`): the session completed at the end of the activity with its
 * derived values (`SPT-003`), the recording summarized with its energy, masked preview and track file, its laps, and the
 * pains signalled on the way as `during` reports (`INT-020`).
 */
export function planRecordingSave(db: ObnixeDatabase, env: Environment, input: RecordingSaveInput): readonly Mutation[] {
  const live = liveRecordingOf(db, input.sessionId);
  if (live.session.status === "completed") throw new SessionStateError(live.session.id, "open");
  return [
    ...rewrite(
      db,
      env,
      live,
      input.track,
      input.processed,
      profileOfSession(live.session),
      { trimStartMs: 0, trimEndMs: null, trackFile: input.stored.file, trackSha256: input.stored.sha256, trackBytes: input.stored.bytes },
      { status: "completed", endedAt: endOf(live, input.track, input.processed) },
    ),
    ...duringPainMutations(db, env, live.session, input.pains),
  ];
}

function duringPainMutations(db: ObnixeDatabase, env: Environment, current: Session, pains: readonly ActivityPain[]): readonly Mutation[] {
  const tracked = trackedZones(db);
  return pains.flatMap((pain) => {
    const plan = painReportMutations({
      sessionId: current.id,
      phase: "during",
      sessionItemId: null,
      strengthSetId: null,
      occurredAt: pain.occurredAt,
      timeZone: current.timeZone,
      newId: env.newId,
      levels: new Map([[pain.zone, pain.level]]),
      tracked,
    });
    if (!tracked.includes(pain.zone)) tracked.push(pain.zone);
    return plan.mutations;
  });
}

/** Deletes the open session with its recording and laps; undoable for 10 s while the journal is kept (`REC-052`). */
export function planRecordingDiscard(db: ObnixeDatabase, sessionId: Id): readonly Mutation[] {
  const live = liveRecordingOf(db, sessionId);
  if (live.session.status === "completed") throw new SessionStateError(live.session.id, "open");
  return [
    ...lapsOf(db, sessionId).map((row): Mutation => ({ kind: "delete", table: "lap", key: row.id })),
    { kind: "delete", table: "recording", key: live.recording.id },
    { kind: "delete", table: "session", key: sessionId },
  ];
}

/** `REC-081`: the session ends at its last journaled instant, or at its start when nothing was journaled. */
export function planInterruption(db: ObnixeDatabase, sessionId: Id, endedAt: EpochMs): readonly Mutation[] {
  const live = liveRecordingOf(db, sessionId);
  return interruptMutations(live.session, Math.max(endedAt, live.session.startedAt) as EpochMs);
}

/** Resuming an interrupted session: the absence counts as a pause until the stop recomputes the paused time. */
export function planRecordingResume(db: ObnixeDatabase, sessionId: Id, now: EpochMs): readonly Mutation[] {
  return resumeMutations(liveRecordingOf(db, sessionId).session, now);
}

/** The stored laps on the time base of the samples, as offsets from `trim.startMs`; they always cover the whole activity. */
export function retrimmedLaps(laps: readonly Pick<Lap, "trigger" | "startOffsetMs" | "endOffsetMs">[], from: TrackTrim, to: TrackTrim): readonly LapBounds[] {
  const shift = from.startMs - to.startMs;
  return laps.map((row, index): LapBounds => ({
    trigger: row.trigger,
    startOffsetMs: index === 0 ? 0 : row.startOffsetMs + shift,
    endOffsetMs: index === laps.length - 1 ? Number.MAX_SAFE_INTEGER : row.endOffsetMs + shift,
  }));
}

function storedTrim(row: Pick<Recording, "trimStartMs" | "trimEndMs">): TrackTrim {
  return { startMs: row.trimStartMs, endMs: row.trimEndMs };
}

/** Processing of a saved recording with its stored laps and the given trim and profile (`SUM-004`, `SUM-005`). */
export function reprocessRecording(db: ObnixeDatabase, live: SessionRecording, track: Track, trim: TrackTrim, profile: ResolvedProfile): ProcessedTrack {
  const laps = retrimmedLaps(lapsOf(db, live.session.id), storedTrim(live.recording), trim);
  return processTrack(track, profile, { laps: { kind: "given", laps }, trim });
}

export class InvalidTrimError extends Error {
  constructor(readonly trim: TrackTrim) {
    super(`Invalid trim ${trim.startMs}..${String(trim.endMs)}`);
  }
}

export interface RecordingRewrite {
  readonly processed: ProcessedTrack;
  readonly mutations: readonly Mutation[];
}

/**
 * `SUM-004`: new `trim_start_ms` and `trim_end_ms`, everything derived from them recomputed in one undoable changeset.
 * The track file is never touched; `trim.endMs` stays null when the end is not trimmed.
 */
export function planTrim(db: ObnixeDatabase, env: Environment, sessionId: Id, track: Track, trim: TrackTrim): RecordingRewrite {
  const live = measuredRecordingOf(db, sessionId);
  const untrimmed = activityWindow(track.samples, track.marks, { startMs: 0, endMs: null });
  if (trim.startMs < 0 || (trim.endMs !== null && (trim.endMs <= trim.startMs || trim.endMs > untrimmed.endMs)) || (trim.endMs === null && trim.startMs >= untrimmed.endMs)) {
    throw new InvalidTrimError(trim);
  }
  const profile = profileOfSession(live.session);
  const processed = reprocessRecording(db, live, track, trim, profile);
  return { processed, mutations: rewrite(db, env, live, track, processed, profile, { trimStartMs: trim.startMs, trimEndMs: trim.endMs }, { endedAt: endOf(live, track, processed) }) };
}

/** A saved recording moved onto another track: a new row, so its own track file stays as it was for an undo. */
export interface TrackReplacement {
  readonly recordingId: Id;
  readonly track: Track;
  readonly stored: StoredTrack;
  /** Columns the new track changes beyond its summary, such as the heart-rate source of a merged file. */
  readonly patch: RecordingPatch;
}

/** `IO-052`: the stored trim and laps processed on the new track, everything derived from it recomputed in one changeset. */
export function planTrackReplacement(db: ObnixeDatabase, env: Environment, sessionId: Id, replacement: TrackReplacement): RecordingRewrite {
  const live = liveRecordingOf(db, sessionId);
  if (live.session.status !== "completed") throw new SessionStateError(live.session.id, "completed");
  const profile = profileOfSession(live.session);
  const trim = storedTrim(live.recording);
  const processed = reprocessRecording(db, live, replacement.track, trim, profile);
  const { stored } = replacement;
  return {
    processed,
    mutations: rewrite(
      db,
      env,
      live,
      replacement.track,
      processed,
      profile,
      { ...replacement.patch, trackFile: stored.file, trackSha256: stored.sha256, trackBytes: stored.bytes },
      { endedAt: endOf(live, replacement.track, processed) },
      replacement.recordingId,
    ),
  };
}

/** `SUM-005`: the stored trim and laps processed with the current algorithm and the session's current profile. */
export function planRecompute(db: ObnixeDatabase, env: Environment, sessionId: Id, track: Track): RecordingRewrite {
  const live = measuredRecordingOf(db, sessionId);
  const profile = profileOfSession(live.session);
  const processed = reprocessRecording(db, live, track, storedTrim(live.recording), profile);
  return { processed, mutations: rewrite(db, env, live, track, processed, profile, {}, {}) };
}

export interface SportChange {
  readonly sport: SportKey;
  /** The values of the new sport the user chose, its `kind` first; the measured ones are derived again. */
  readonly values: FieldValues;
}

function keptValues(values: FieldValues, sport: SportKey): FieldValues {
  const keys = new Set(sportOf(sport).sessionFields.map((field) => field.key));
  return Object.fromEntries(Object.entries(values).filter(([key]) => keys.has(key)));
}

/**
 * `SUM-004`: another sport or variant, measured again with its profile in one undoable changeset. The gear and the program slot
 * of another sport are detached; the values the new sport does not have are dropped.
 */
export function planSportChange(db: ObnixeDatabase, env: Environment, sessionId: Id, track: Track, change: SportChange): RecordingRewrite {
  const saved = measuredRecordingOf(db, sessionId);
  const profile = resolveProfile(change.sport, change.values);
  if (profile === null) throw new NotRecordableError(change.sport);
  const changed: Session = { ...saved.session, sport: change.sport, values: { ...keptValues(saved.session.values, change.sport), ...change.values } };
  const live = { session: changed, recording: saved.recording };
  const processed = reprocessRecording(db, live, track, storedTrim(saved.recording), profile);
  const gearSport = saved.session.gearId === null ? null : (db.select({ sport: gear.sport }).from(gear).where(eq(gear.id, saved.session.gearId)).get()?.sport ?? null);
  const slotSport = saved.session.slotId === null ? null : (db.select({ sport: programSlot.sport }).from(programSlot).where(eq(programSlot.id, saved.session.slotId)).get()?.sport ?? null);
  const sessionExtra: Partial<NewRow<"session">> = {
    sport: change.sport,
    ...(gearSport !== null && gearSport !== change.sport ? { gearId: null } : {}),
    ...(slotSport !== null && slotSport !== change.sport ? { slotId: null, variantId: null, countsInRotation: false } : {}),
  };
  return { processed, mutations: rewrite(db, env, live, track, processed, profile, {}, sessionExtra) };
}
