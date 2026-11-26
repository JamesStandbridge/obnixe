import { eq } from "drizzle-orm";
import { recording, session, sports } from "@obnixe/schema";
import type { Recording, Session } from "@obnixe/schema";
import type { ObnixeDatabase } from "../database.ts";
import { analyzeRecording, heartRateZoneReport } from "../tracking/analysis.ts";
import type { ProcessedTrack } from "../tracking/batch.ts";
import { decodeTrack, TrackDecodeError } from "../tracking/codec/track.ts";
import type { Track } from "../tracking/codec/track.ts";
import { maskTrack } from "../tracking/privacy.ts";
import type { PointRange } from "../tracking/privacy.ts";
import { activePrivacyMask } from "../tracking/privacyZones.ts";
import { resolveProfile } from "../tracking/profile.ts";
import type { ResolvedProfile } from "../tracking/profile.ts";
import { lttb } from "../tracking/simplify.ts";
import { slowestPaceSecondsPerKm } from "../tracking/stages/derive.ts";
import type { StretchSummary, TrackSeries } from "../tracking/stages/derive.ts";
import { heartRateReader } from "../tracking/zones.ts";
import type { ToolInput } from "./contract.ts";
import type { AgentEnvironment, Json, ToolResult } from "./environment.ts";
import { ToolInputError } from "./environment.ts";
import { frenchDay } from "./format.ts";
import { averageSpeedKmh, kmh, meters, paceSecondsPerKm, recordingSummaries, seconds } from "./recordings.ts";

/** Points returned by `get_activity_track` when the agent sets no budget (`INT-041`). */
export const defaultTrackPoints = 1000;

interface LoadedActivity {
  readonly session: Session;
  readonly recording: Recording;
  readonly profile: ResolvedProfile;
  readonly track: Track;
  readonly processed: ProcessedTrack;
}

function loadActivity(db: ObnixeDatabase, env: AgentEnvironment, sessionId: string): LoadedActivity {
  const owner = db.select().from(session).where(eq(session.id, sessionId as Session["id"])).get();
  if (owner === undefined) throw new ToolInputError(`No session with id '${sessionId}'. Call get_history to see the session ids.`);
  if (owner.deletedAt !== null) throw new ToolInputError(`Session '${sessionId}' is in the trash. The user can restore it from the phone.`);
  const row = db.select().from(recording).where(eq(recording.sessionId, owner.id)).get();
  if (row === undefined) throw new ToolInputError(`Session '${sessionId}' was not recorded with the phone or imported from a watch, so it has no track.`);
  if (row.trackFile === null) throw new ToolInputError(`Session '${sessionId}' has no stored track; its summary is in get_history.`);
  const profile = resolveProfile(owner.sport, owner.values);
  if (profile === null) throw new ToolInputError(`Session '${sessionId}' is a ${owner.sport} activity without a GPS profile, so its track cannot be analysed; its summary is in get_history.`);
  const bytes = env.readTrack(row.trackFile);
  if (bytes === null) throw new ToolInputError(`The track of session '${sessionId}' cannot be read on this phone; its summary is in get_history.`);
  let track: Track;
  try {
    track = decodeTrack(bytes);
  } catch (error) {
    if (error instanceof TrackDecodeError) throw new ToolInputError(`The track of session '${sessionId}' is damaged (${error.reason}); its summary is in get_history.`);
    throw error;
  }
  const processed = analyzeRecording(db, { session: owner, recording: row }, profile, track);
  return { session: owner, recording: row, profile, track, processed };
}

function activityLabel(row: Pick<Session, "sport" | "localDate">): string {
  return `${sports[row.sport].label} du ${frenchDay(row.localDate)}`;
}

function stretchJson(stretch: StretchSummary, profile: ResolvedProfile): Record<string, Json> {
  return {
    distanceMeters: meters(stretch.distanceMm),
    elapsedSeconds: seconds(stretch.elapsedMs),
    movingSeconds: seconds(stretch.movingMs),
    paceSecondsPerKm: paceSecondsPerKm(profile, stretch.movingMs, stretch.distanceMm),
    gradeAdjustedPaceSecondsPerKm: stretch.gradeAdjustedDistanceMm === null ? null : paceSecondsPerKm(profile, stretch.movingMs, stretch.gradeAdjustedDistanceMm),
    speedKmh: averageSpeedKmh(stretch.movingMs, stretch.distanceMm),
    ascentMeters: stretch.ascentMm === null ? null : meters(stretch.ascentMm),
    descentMeters: stretch.descentMm === null ? null : meters(stretch.descentMm),
    cadenceAvg: stretch.cadenceAvg,
    heartRateAvg: stretch.heartRateAvg,
    heartRateMax: stretch.heartRateMax,
  };
}

function heartRateZonesJson(db: ObnixeDatabase, loaded: LoadedActivity): Json {
  const report = heartRateZoneReport(db, loaded.session.startedAt, loaded.track.samples.heartRate, loaded.processed.moving);
  if (report === null) return null;
  const { time } = report;
  return {
    maxHeartRate: report.maxHeartRate,
    maxHeartRateSource: report.source,
    coveredSeconds: seconds(time.coveredMs),
    belowZone1Seconds: seconds(time.belowMs),
    zones: report.zones.map((bounds) => ({ zone: bounds.zone, minBpm: Math.round(bounds.minBpm), maxBpm: Math.round(bounds.maxBpm), seconds: seconds(time.byZone[bounds.zone]) })),
  };
}

export function getActivity(db: ObnixeDatabase, env: AgentEnvironment, input: ToolInput<"get_activity">): ToolResult {
  const loaded = loadActivity(db, env, input.sessionId);
  const { session: owner, profile, processed } = loaded;
  const { summary, details } = processed;
  return {
    kind: "read",
    summary: `Analyse · ${activityLabel(owner)}`,
    data: {
      sessionId: owner.id,
      sport: owner.sport,
      title: owner.title,
      localDate: owner.localDate,
      startedAt: new Date(owner.startedAt).toISOString(),
      recording: recordingSummaries(db, [owner]).get(owner.id) ?? null,
      gradeAdjustedPaceSecondsPerKm: details.gradeAdjustedDistanceMm === null ? null : paceSecondsPerKm(profile, summary.movingMs, details.gradeAdjustedDistanceMm),
      vamMetersPerHour: details.vamMetersPerHour === null ? null : Math.round(details.vamMetersPerHour),
      splits: processed.splits.map((split) => ({ index: split.index, ...stretchJson(split, profile) })),
      laps: processed.laps.map((item) => ({
        trigger: item.bounds.trigger,
        startOffsetSeconds: seconds(item.bounds.startOffsetMs),
        endOffsetSeconds: seconds(item.bounds.endOffsetMs),
        ...stretchJson(item, profile),
      })),
      heartRateZones: heartRateZonesJson(db, loaded),
      dataQuality: {
        goodFixPermille: summary.goodFixPermille,
        preciseFixPermille: details.preciseFixPermille,
        heartRateCoveragePermille: details.heartRateCoveragePermille,
        rejectedFixes: details.gateRejections + details.outlierRejections,
        simulated: summary.simulated,
      },
    },
  };
}

function gather(column: ArrayLike<number>, indices: ArrayLike<number>): Float64Array {
  return Float64Array.from({ length: indices.length }, (_, position) => column[indices[position] ?? 0] ?? 0);
}

/**
 * Series indices of at most `maxPoints` visible points (`INT-041`): Largest Triangle Three Buckets over time, half of the
 * budget on speed and half on the known altitudes, so the extremes of both survive. Only visible points are candidates.
 */
export function sampleTrack(series: Pick<TrackSeries, "t" | "speed" | "altitude">, visible: readonly PointRange[], maxPoints: number): Uint32Array {
  const candidates: number[] = [];
  for (const { start, end } of visible) for (let index = start; index < end; index += 1) candidates.push(index);
  if (candidates.length <= maxPoints) return Uint32Array.from(candidates);
  const t = gather(series.t, candidates);
  const chosen = new Uint8Array(candidates.length);
  const known: number[] = [];
  candidates.forEach((index, position) => {
    if (!Number.isNaN(series.altitude[index] ?? Number.NaN)) known.push(position);
  });
  const speedBudget = known.length < 3 ? maxPoints : Math.ceil(maxPoints / 2);
  for (const position of lttb(t, gather(series.speed, candidates), speedBudget)) chosen[position] = 1;
  if (speedBudget < maxPoints) {
    const knownCandidates = known.map((position) => candidates[position] ?? 0);
    for (const position of lttb(gather(t, known), gather(series.altitude, knownCandidates), maxPoints - speedBudget)) chosen[known[position] ?? 0] = 1;
  }
  return Uint32Array.from(candidates.filter((_, position) => chosen[position] === 1));
}

const coordinate = (degrees: number): number => Math.round(degrees * 1e6) / 1e6;

function paceAt(speed: number): number | null {
  if (speed <= 0) return null;
  const pace = 1000 / speed;
  return pace > slowestPaceSecondsPerKm ? null : Math.round(pace);
}

export function getActivityTrack(db: ObnixeDatabase, env: AgentEnvironment, input: ToolInput<"get_activity_track">): ToolResult {
  const { session: owner, profile, track, processed } = loadActivity(db, env, input.sessionId);
  const { series } = processed;
  const mask = activePrivacyMask(db);
  const masked = maskTrack(series, mask.zones, mask);
  const kept = sampleTrack(series, masked.visible, input.maxPoints ?? defaultTrackPoints);
  const pace = profile.primary === "pace";
  const heartRateAt = heartRateReader(track.samples.heartRate);
  const startMs = processed.elapsed.startMs;
  const segments: Json[][] = [];
  let next = 0;
  for (const { end } of masked.visible) {
    const points: Json[] = [];
    for (; next < kept.length && (kept[next] ?? 0) < end; next += 1) {
      const index = kept[next] ?? 0;
      const t = series.t[index] ?? 0;
      const altitude = series.altitude[index] ?? Number.NaN;
      const speed = series.speed[index] ?? 0;
      points.push([
        seconds(t - startMs),
        coordinate(series.latitude[index] ?? 0),
        coordinate(series.longitude[index] ?? 0),
        Math.round(series.distance[index] ?? 0),
        Number.isNaN(altitude) ? null : Math.round(altitude * 10) / 10,
        pace ? paceAt(speed) : kmh(speed),
        heartRateAt(t),
      ]);
    }
    if (points.length > 0) segments.push(points);
  }
  return {
    kind: "read",
    summary: `Trace GPS · ${activityLabel(owner)}`,
    data: {
      sessionId: owner.id,
      sport: owner.sport,
      startedAt: new Date(track.startedAt + startMs).toISOString(),
      masked: masked.hidden.includes(1),
      pointCount: kept.length,
      fields: ["elapsedSeconds", "latitude", "longitude", "distanceMeters", "altitudeMeters", pace ? "paceSecondsPerKm" : "speedKmh", "heartRate"],
      segments,
    },
  };
}
