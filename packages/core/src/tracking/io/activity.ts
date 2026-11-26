import type { EpochMs, ImportFormat } from "@obnixe/schema";
import type { Track } from "../codec/track.ts";
import { bridgeMaximumMs } from "../stages/derive.ts";
import { toSampleColumns } from "../types.ts";
import type { Sample, TrackerMark } from "../types.ts";
import { isHeartRateReading } from "../zones.ts";
import type { TimeSpan } from "../zones.ts";
import { ImportError } from "./errors.ts";
import type { SportGuess } from "./sports.ts";

/** Accuracy given to file positions without one: the gate refuses a fix without accuracy (`GPS-020`). */
export const fileHorizontalAccuracyDm = 50;
export const fileVerticalAccuracyDm = 50;

export type ArchiveFormat = Extract<ImportFormat, "garmin_archive">;
export type FileFormat = Exclude<ImportFormat, ArchiveFormat>;

/** A track point as read from a file, at an absolute instant. */
export interface FilePoint {
  readonly time: number;
  readonly latitudeE7: number | null;
  readonly longitudeE7: number | null;
  /** Orthometric altitude. */
  readonly altitudeMm: number | null;
  readonly heartRate: number | null;
  /** Cycles per minute: strides on foot, pedal revolutions on a bike. */
  readonly cadence: number | null;
  readonly speedMmS: number | null;
  readonly courseCentiDeg: number | null;
  /** Fix accuracies and barometric pressure, carried only by an Obnixe export so that importing it again gives the same results (`IO-001`). */
  readonly horizontalAccuracyDm: number | null;
  readonly verticalAccuracyDm: number | null;
  readonly speedAccuracyCmS: number | null;
  readonly pressurePa: number | null;
}

/** A track point written to a file, at an absolute instant, with the fix accuracies and pressure the import reads back (`IO-001`). */
export interface ExportPoint {
  readonly latitudeE7: number;
  readonly longitudeE7: number;
  /** Orthometric altitude. */
  readonly altitudeMm: number | null;
  readonly time: number;
  readonly heartRate: number | null;
  readonly cadence: number | null;
  readonly speedMmS: number | null;
  readonly courseCentiDeg: number | null;
  readonly horizontalAccuracyDm: number | null;
  readonly verticalAccuracyDm: number | null;
  readonly speedAccuracyCmS: number | null;
  readonly pressurePa: number | null;
  /** Counted distance since the start (`GPS-037`). */
  readonly distanceMm: number;
}

export interface FileTimerEvent {
  readonly time: number;
  readonly kind: "start" | "stop";
}

/** Totals stated by the file (`IO-011`): FIT `session`, TCX `Lap` sums. */
export interface FileTotals {
  readonly elapsedMs: number | null;
  readonly timerMs: number | null;
  readonly distanceMm: number | null;
  readonly energyKcal: number | null;
  readonly heartRateAvg: number | null;
  readonly heartRateMax: number | null;
}

/** A pool swim from FIT `session` and `length` messages (`IO-050`). */
export interface PoolSwim {
  readonly poolLengthMeters: number;
  readonly lengths: number;
  readonly distanceMeters: number;
}

/** What a reader extracts from one file, before it is laid on a time base. */
export interface FileActivity {
  readonly format: FileFormat;
  readonly externalId: string;
  readonly device: string | null;
  readonly name: string | null;
  readonly sport: SportGuess | null;
  /** Declared start: FIT `session.start_time`, TCX `Id`. */
  readonly startTime: number | null;
  readonly points: readonly FilePoint[];
  /** Indices of `points` that start a new continuous part (GPX `trkseg`, `trk`): the boundary is a pause. */
  readonly segmentStarts: readonly number[];
  /** Timer start and stop events (FIT): when present, they alone give the start, pauses and end. */
  readonly timer: readonly FileTimerEvent[];
  readonly lapStarts: readonly number[];
  readonly totals: FileTotals | null;
  readonly pool: PoolSwim | null;
}

/** A track point on the track time base: milliseconds since `ImportedActivity.startedAt`. */
export interface ImportedPoint extends Omit<FilePoint, "time"> {
  readonly t: number;
}

/** A file read into the common model (`IO-010`): every format reaches the batch processing through it. */
export interface ImportedActivity {
  readonly format: FileFormat;
  /** Identity of the file across devices and backups (`DAT-031`). */
  readonly externalId: string;
  readonly device: string | null;
  readonly name: string | null;
  readonly sport: SportGuess | null;
  readonly startedAt: EpochMs;
  readonly points: readonly ImportedPoint[];
  /** `start`, `pause`, `resume` and `stop`, in order. */
  readonly marks: readonly TrackerMark[];
  /** Contiguous laps on the track time base; empty when the file has none. */
  readonly laps: readonly TimeSpan[];
  readonly totals: FileTotals | null;
  readonly pool: PoolSwim | null;
}

const maxTrackMs = 4_294_967_295;

function timerMarks(timer: readonly FileTimerEvent[], startedAt: number): TrackerMark[] {
  const marks: TrackerMark[] = [];
  let running = false;
  for (const event of timer) {
    const t = event.time - startedAt;
    if (event.kind === "start" && !running) marks.push({ kind: marks.length === 0 ? "start" : "resume", t });
    if (event.kind === "stop" && running) marks.push({ kind: "pause", t });
    running = event.kind === "start";
  }
  const last = marks[marks.length - 1];
  if (last?.kind === "pause") marks[marks.length - 1] = { kind: "stop", t: last.t };
  return marks;
}

function segmentMarks(points: readonly ImportedPoint[], segmentStarts: readonly number[], endMs: number): TrackerMark[] {
  const marks: TrackerMark[] = [{ kind: "start", t: 0 }];
  for (const index of segmentStarts) {
    const previous = points[index - 1];
    const next = points[index];
    if (previous === undefined || next === undefined || next.t <= previous.t) continue;
    marks.push({ kind: "pause", t: previous.t }, { kind: "resume", t: next.t });
  }
  marks.push({ kind: "stop", t: endMs });
  return marks;
}

function lapSpans(starts: readonly number[], startedAt: number, endMs: number): TimeSpan[] {
  const offsets = [...new Set(starts.map((start) => Math.max(start - startedAt, 0)))].filter((t) => t < endMs).sort((left, right) => left - right);
  if (offsets.length > 0 && offsets[0] !== 0) offsets[0] = 0;
  return offsets.map((startMs, index) => ({ startMs, endMs: offsets[index + 1] ?? endMs }));
}

/**
 * Lays a file on the track time base: `startedAt` is the first timer start, or the declared start, or the first point;
 * points before it are dropped. Refuses times going back (`IO-013`) and a file with neither points nor totals.
 */
export function assembleActivity(file: FileActivity): ImportedActivity {
  for (let index = 1; index < file.points.length; index += 1) {
    if ((file.points[index]?.time ?? 0) < (file.points[index - 1]?.time ?? 0)) throw new ImportError("unordered_time", `point ${index} goes back in time`);
  }
  for (let index = 1; index < file.timer.length; index += 1) {
    if ((file.timer[index]?.time ?? 0) < (file.timer[index - 1]?.time ?? 0)) throw new ImportError("unordered_time", `timer event ${index} goes back in time`);
  }
  const firstStart = file.timer.find((event) => event.kind === "start")?.time ?? null;
  const first = file.points[0]?.time ?? null;
  const startedAt = firstStart ?? (file.startTime === null ? first : Math.min(file.startTime, first ?? file.startTime));
  if (startedAt === null || (file.points.length === 0 && file.totals === null && file.pool === null)) throw new ImportError("no_activity_data", "the file has no track point and no totals");
  const firstKept = file.points.findIndex((point) => point.time >= startedAt);
  const from = firstKept < 0 ? file.points.length : firstKept;
  const points: ImportedPoint[] = file.points.slice(from).map(({ time, ...point }) => ({ ...point, t: time - startedAt }));
  const lastEnd = Math.max(points[points.length - 1]?.t ?? 0, file.totals?.elapsedMs ?? 0);
  const timed = timerMarks(file.timer, startedAt);
  const lastTimed = timed[timed.length - 1];
  if (lastTimed !== undefined && lastTimed.kind !== "stop") timed.push({ kind: "stop", t: Math.max(lastEnd, lastTimed.t) });
  const segmentStarts = file.segmentStarts.map((index) => index - from).filter((index) => index > 0);
  const marks = timed.length > 0 ? timed : segmentMarks(points, segmentStarts, lastEnd);
  const endMs = marks[marks.length - 1]?.t ?? 0;
  if (endMs <= 0) throw new ImportError("no_activity_data", "the activity has no duration");
  if (endMs > maxTrackMs) throw new ImportError("invalid_value", "the activity lasts more than 49 days");
  return {
    format: file.format,
    externalId: file.externalId,
    device: file.device,
    name: file.name,
    sport: file.sport,
    startedAt: startedAt as EpochMs,
    points,
    marks,
    laps: lapSpans(file.lapStarts, startedAt, endMs),
    totals: file.totals,
    pool: file.pool,
  };
}

/**
 * The samples of an import (`IO-011`): a fix per positioned point with the file accuracies, a pressure and a heart-rate sample per reading,
 * and, when the sport counts steps, the cumulative steps of the file cadence, two per stride, held across the spans the
 * processing bridges.
 */
export function importedTrack(activity: ImportedActivity, countsSteps: boolean): Track {
  const samples: Sample[] = [];
  let steps = 0;
  let previous: ImportedPoint | null = null;
  const hasCadence = countsSteps && activity.points.some((point) => point.cadence !== null);
  for (const point of activity.points) {
    if (point.latitudeE7 !== null && point.longitudeE7 !== null) {
      samples.push({
        type: "fix",
        t: point.t,
        fixAgeMs: 0,
        latitudeE7: point.latitudeE7,
        longitudeE7: point.longitudeE7,
        altitudeEllipsoidMm: null,
        altitudeMslMm: point.altitudeMm,
        horizontalAccuracyDm: point.horizontalAccuracyDm ?? fileHorizontalAccuracyDm,
        verticalAccuracyDm: point.altitudeMm === null ? null : (point.verticalAccuracyDm ?? fileVerticalAccuracyDm),
        speedCmS: point.speedMmS === null ? null : Math.round(point.speedMmS / 10),
        speedAccuracyCmS: point.speedMmS === null ? null : point.speedAccuracyCmS,
        bearingCentiDeg: point.courseCentiDeg,
        bearingAccuracyCentiDeg: null,
        simulated: false,
      });
    }
    if (point.pressurePa !== null) samples.push({ type: "pressure", t: point.t, pascals: point.pressurePa });
    if (point.heartRate !== null && isHeartRateReading(point.heartRate)) samples.push({ type: "heart_rate", t: point.t, bpm: point.heartRate, contact: "contact", rrInterval: null });
    if (hasCadence) {
      const span = previous === null ? 0 : point.t - previous.t;
      if (previous !== null && previous.cadence !== null && span <= bridgeMaximumMs) steps += (2 * previous.cadence * span) / 60_000;
      samples.push({ type: "steps", t: point.t, count: Math.floor(steps) });
    }
    previous = point;
  }
  return { startedAt: activity.startedAt, samples: toSampleColumns(samples), marks: activity.marks };
}
