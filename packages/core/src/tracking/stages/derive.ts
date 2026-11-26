import type { BestEffortKey, LapTrigger, RecordingProfile, RecordingSettings, SportKey } from "@obnixe/schema";
import { minettiRunningCost } from "../energy.ts";
import type { HeartRateColumns, TrackerMark } from "../types.ts";
import { forEachHeartRateSpan, isHeartRateReading } from "../zones.ts";
import type { TimeSpan } from "../zones.ts";

/** An interval longer than this without an accepted fix is a gap (`GPS-040`). */
export const gapMinimumMs = 10_000;
/** A gap up to this long, at a plausible speed, is bridged by a straight segment (`GPS-040`). */
export const bridgeMaximumMs = 180_000;
/** A window holding a manual pause longer than this cannot be a best effort (`DEC-05`). */
export const bestEffortPauseLimitMs = 300_000;
/** Centered window of the maximum speed (`speed_max`). */
export const maxSpeedWindowMs = 3000;
/** `pace_now` slower than this is not shown (`GPS-035`). */
export const slowestPaceSecondsPerKm = 1800;

/**
 * State of the interval ending at a sample: `bridged` is a gap filled by a straight segment and counted, `gap` is excluded
 * from distance and moving time and drawn dashed (`GPS-033`, `GPS-037`, `GPS-040`). The index is the code stored in series.
 */
export const motionIntervalKinds = ["stopped", "moving", "paused", "bridged", "gap"] as const;
export type MotionIntervalKind = (typeof motionIntervalKinds)[number];

export interface MotionInterval extends TimeSpan {
  readonly kind: MotionIntervalKind;
}

export const intervalCodes: Readonly<Record<MotionIntervalKind, number>> = { stopped: 0, moving: 1, paused: 2, bridged: 3, gap: 4 };

/** Distance, moving time, elevation and heart rate are only accumulated over these intervals. */
export function isCounted(kind: MotionIntervalKind): boolean {
  return kind === "moving" || kind === "bridged";
}

export function isCountedCode(code: number): boolean {
  return code === intervalCodes.moving || code === intervalCodes.bridged;
}

export interface IntervalFacts {
  readonly durationMs: number;
  readonly meters: number;
  /** The filter restarted on the interval's end: the connecting segment is a gap (`GPS-030`). */
  readonly restart: boolean;
  readonly paused: boolean;
  readonly moving: boolean;
}

/** A manual pause wins; a gap or restart is bridged when short and at a speed between `v_stop` and `v_max` (`GPS-040`). */
export function intervalKind(facts: IntervalFacts, profile: RecordingProfile): MotionIntervalKind {
  if (facts.paused) return "paused";
  if (facts.restart || facts.durationMs > gapMinimumMs) {
    const speedMmS = facts.durationMs > 0 ? (facts.meters * 1_000_000) / facts.durationMs : Number.POSITIVE_INFINITY;
    return facts.durationMs <= bridgeMaximumMs && speedMmS >= profile.motion.stopSpeedMmS && speedMmS <= profile.maxSpeedMmS ? "bridged" : "gap";
  }
  return facts.moving ? "moving" : "stopped";
}

/**
 * Manual pauses from the journal marks: `pause` and `stop` open one, `resume` and a later `start` close it. An interval is
 * paused when its end falls in `(pause, resume]`. Queries must not go back in time.
 */
export class PauseLedger {
  private readonly closed: TimeSpan[] = [];
  private openSince: number | null = null;
  private head = 0;

  mark(mark: TrackerMark): void {
    switch (mark.kind) {
      case "pause":
      case "stop":
        this.openSince ??= mark.t;
        break;
      case "resume":
      case "start":
        if (this.openSince !== null && mark.t > this.openSince) this.closed.push({ startMs: this.openSince, endMs: mark.t });
        if (this.openSince !== null) this.openSince = null;
        break;
      case "lap":
        break;
      default: {
        const unreachable: never = mark.kind;
        throw new Error(`Unhandled mark ${String(unreachable)}`);
      }
    }
  }

  isPaused(t: number): boolean {
    while (this.head < this.closed.length && (this.closed[this.head]?.endMs ?? 0) < t) this.head += 1;
    const span = this.closed[this.head];
    if (span !== undefined && t > span.startMs && t <= span.endMs) return true;
    return this.openSince !== null && t > this.openSince;
  }

  /** Manual pauses clipped to `window`, sorted; an open pause runs to the end of the window. */
  spans(window: TimeSpan): readonly TimeSpan[] {
    const all = this.openSince === null ? this.closed : [...this.closed, { startMs: this.openSince, endMs: window.endMs }];
    const clipped: TimeSpan[] = [];
    for (const span of all) {
      const startMs = Math.max(span.startMs, window.startMs);
      const endMs = Math.min(span.endMs, window.endMs);
      if (endMs > startMs) clipped.push({ startMs, endMs });
    }
    return clipped;
  }
}

/** Ratio of the Minetti running cost on the grade to the flat cost: the grade-adjusted speed factor (`GPS-050`); 1 without grade. */
export function gradeAdjustmentFactor(grade: number): number {
  return Number.isNaN(grade) ? 1 : minettiRunningCost(grade) / minettiRunningCost(0);
}

/** `speed_now`: exponential average of the filtered speed with the profile's time constant (`GPS-035`). */
export class SpeedSmoother {
  private readonly timeConstantMs: number;
  private value: number | null = null;
  private t = 0;

  constructor(timeConstantMs: number) {
    this.timeConstantMs = timeConstantMs;
  }

  push(t: number, speed: number): number {
    if (this.value === null) this.value = speed;
    else this.value += (speed - this.value) * (1 - Math.exp(-Math.max(t - this.t, 0) / this.timeConstantMs));
    this.t = t;
    return this.value;
  }
}

export type AutoLap = RecordingSettings["autoLap"];

/** Cumulative counted values at an instant, on which laps are triggered. */
export interface LapPoint {
  readonly t: number;
  readonly distance: number;
  readonly moving: number;
}

function between(from: LapPoint, to: LapPoint, fraction: number): LapPoint {
  return { t: from.t + (to.t - from.t) * fraction, distance: from.distance + (to.distance - from.distance) * fraction, moving: from.moving + (to.moving - from.moving) * fraction };
}

/**
 * Automatic laps by counted distance or moving time (`REC-041`), counted from the last lap of any kind, so a manual lap
 * restarts the count. Shared by the live tracker and the batch processing.
 */
export class AutoLapper {
  private readonly autoLap: AutoLap;
  private reference: LapPoint = { t: 0, distance: 0, moving: 0 };

  constructor(autoLap: AutoLap) {
    this.autoLap = autoLap;
  }

  get trigger(): Extract<LapTrigger, "distance" | "duration"> | null {
    return this.autoLap?.trigger ?? null;
  }

  restart(at: LapPoint): void {
    this.reference = at;
  }

  /** Fractions of the step from `from` to `to` at which automatic laps end, in order. */
  advance(from: LapPoint, to: LapPoint): readonly number[] {
    const autoLap = this.autoLap;
    if (autoLap === null) return [];
    const fractions: number[] = [];
    const value = (point: LapPoint): number => (autoLap.trigger === "distance" ? point.distance : point.moving);
    const length = autoLap.trigger === "distance" ? autoLap.meters : autoLap.ms;
    const start = value(from);
    const span = value(to) - start;
    while (span > 0 && value(to) >= value(this.reference) + length) {
      const fraction = (value(this.reference) + length - start) / span;
      fractions.push(fraction);
      this.reference = between(from, to, fraction);
    }
    return fractions;
  }
}

/**
 * Columnar series of a processed track, one entry per retained fix (`PRF-031`). Times are on the track time base; the
 * cumulative columns only grow over counted intervals (`isCountedCode`), so any window is a difference of interpolated values.
 */
export interface TrackSeries {
  readonly length: number;
  readonly t: Float64Array;
  /** Index of the fix in the input `SampleColumns`, for exports at the original instants (`IO-002`). */
  readonly fixIndex: Uint32Array;
  /** Smoothed position in degrees (`GPS-031`). */
  readonly latitude: Float64Array;
  readonly longitude: Float64Array;
  /** Smoothed horizontal speed in m/s. */
  readonly speed: Float32Array;
  /** Smoothed orthometric altitude in meters, `NaN` where unknown. */
  readonly altitude: Float32Array;
  /** `gradeSeries`, `NaN` where not computed. */
  readonly grade: Float64Array;
  /** `intervalCodes` of the interval ending at each entry; entry 0 has no interval. */
  readonly interval: Uint8Array;
  /** Meters (`GPS-037`). */
  readonly distance: Float64Array;
  readonly moving: Float64Array;
  /** Meters, from the hysteresis automaton (`ELE-010`). */
  readonly ascent: Float64Array;
  readonly descent: Float64Array;
  /** Grade-adjusted meters, for sports with GAP only (`GPS-050`). */
  readonly gradeAdjustedDistance: Float64Array | null;
  /** Steps taken during counted intervals, with a pedometer. */
  readonly steps: Float64Array | null;
  /** Heartbeats and heart-rate coverage in ms over counted intervals, with a heart-rate stream. */
  readonly heartBeats: Float64Array | null;
  readonly heartRateMs: Float64Array | null;
}

/** First fractional index at or after `from` where the non-decreasing `column` reaches `value`; the last index when it never does. */
export function locate(column: Float64Array, value: number, from: number = 0): number {
  const last = column.length - 1;
  if (last <= 0) return 0;
  let index = Math.max(Math.ceil(from), 1);
  if ((column[Math.floor(from)] ?? 0) >= value) return from;
  while (index <= last && (column[index] ?? 0) < value) index += 1;
  if (index > last) return last;
  const low = column[index - 1] ?? 0;
  const high = column[index] ?? 0;
  return high === low ? index : index - 1 + (value - low) / (high - low);
}

/** Fractional index of a time, by binary search; clamped to the series. */
export function locateTime(t: Float64Array, time: number): number {
  const last = t.length - 1;
  if (last <= 0 || time <= (t[0] ?? 0)) return 0;
  if (time >= (t[last] ?? 0)) return last;
  let low = 0;
  let high = last;
  while (high - low > 1) {
    const middle = (low + high) >> 1;
    if ((t[middle] ?? 0) < time) low = middle;
    else high = middle;
  }
  const from = t[low] ?? 0;
  const to = t[high] ?? 0;
  return to === from ? high : low + (time - from) / (to - from);
}

/** Linear interpolation of a column at a fractional index. */
export function valueAt(column: ArrayLike<number>, x: number): number {
  const index = Math.floor(x);
  const low = column[index] ?? 0;
  const fraction = x - index;
  return fraction === 0 ? low : low + ((column[index + 1] ?? low) - low) * fraction;
}

/** Interval kinds as runs on the track time base, from the first to the last entry. */
export function motionIntervals(series: TrackSeries): readonly MotionInterval[] {
  const intervals: MotionInterval[] = [];
  for (let index = 1; index < series.length; index += 1) {
    const kind = motionIntervalKinds[series.interval[index] ?? 0] ?? "stopped";
    const startMs = series.t[index - 1] ?? 0;
    const endMs = series.t[index] ?? 0;
    const previous = intervals.at(-1);
    if (previous !== undefined && previous.kind === kind && previous.endMs === startMs) intervals[intervals.length - 1] = { kind, startMs: previous.startMs, endMs };
    else if (endMs > startMs) intervals.push({ kind, startMs, endMs });
  }
  return intervals;
}

/** The counted intervals merged into sorted, disjoint spans: the moving time of the energy and zone computations. */
export function countedSpans(intervals: readonly MotionInterval[]): readonly TimeSpan[] {
  const spans: TimeSpan[] = [];
  for (const interval of intervals) {
    if (!isCounted(interval.kind)) continue;
    const previous = spans.at(-1);
    if (previous !== undefined && previous.endMs === interval.startMs) spans[spans.length - 1] = { startMs: previous.startMs, endMs: interval.endMs };
    else spans.push({ startMs: interval.startMs, endMs: interval.endMs });
  }
  return spans;
}

export interface HeartRateAccumulation {
  readonly beats: Float64Array;
  readonly coveredMs: Float64Array;
}

/** Heartbeats and covered milliseconds accumulated over the counted intervals of `series`, weighted by time (`SPT-003`). */
export function accumulateHeartRate(series: Pick<TrackSeries, "length" | "t" | "interval">, heartRate: HeartRateColumns): HeartRateAccumulation {
  const length = series.length;
  const beats = new Float64Array(length);
  const coveredMs = new Float64Array(length);
  if (length < 2) return { beats, coveredMs };
  let index = 1;
  forEachHeartRateSpan(heartRate, { startMs: series.t[0] ?? 0, endMs: series.t[length - 1] ?? 0 }, (startMs, endMs, bpm) => {
    while (index < length && (series.t[index] ?? 0) <= startMs) index += 1;
    for (let interval = index; interval < length; interval += 1) {
      const from = series.t[interval - 1] ?? 0;
      if (from >= endMs) break;
      if (!isCountedCode(series.interval[interval] ?? 0)) continue;
      const overlap = Math.min(endMs, series.t[interval] ?? 0) - Math.max(startMs, from);
      if (overlap <= 0) continue;
      beats[interval] = (beats[interval] ?? 0) + (bpm * overlap) / 60_000;
      coveredMs[interval] = (coveredMs[interval] ?? 0) + overlap;
    }
  });
  for (let interval = 1; interval < length; interval += 1) {
    beats[interval] = (beats[interval] ?? 0) + (beats[interval - 1] ?? 0);
    coveredMs[interval] = (coveredMs[interval] ?? 0) + (coveredMs[interval - 1] ?? 0);
  }
  return { beats, coveredMs };
}

/** Highest heart-rate reading in `[startMs, endMs)`. */
export function heartRateMaxBetween(heartRate: HeartRateColumns, startMs: number, endMs: number): number | null {
  const { t, bpm, length } = heartRate;
  let low = 0;
  let high = length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if ((t[middle] ?? 0) < startMs) low = middle + 1;
    else high = middle;
  }
  let max: number | null = null;
  for (let index = low; index < length && (t[index] ?? 0) < endMs; index += 1) {
    const rate = bpm[index] ?? 0;
    if (isHeartRateReading(rate) && (max === null || rate > max)) max = rate;
  }
  return max;
}

/** Metrics of a stretch of an activity: a split, a lap (`GPS-061`). Pace, speed and GAP follow from moving time over distance. */
export interface StretchSummary extends TimeSpan {
  readonly distanceMm: number;
  readonly elapsedMs: number;
  readonly movingMs: number;
  readonly ascentMm: number | null;
  readonly descentMm: number | null;
  readonly gradeAdjustedDistanceMm: number | null;
  /** Steps per minute of moving time. */
  readonly cadenceAvg: number | null;
  readonly heartRateAvg: number | null;
  readonly heartRateMax: number | null;
}

export interface SplitSummary extends StretchSummary {
  /** From 0; the last split may be shorter than the profile's split length. */
  readonly index: number;
}

const millimeters = (meters: number): number => Math.round(meters * 1000);

/** Every cumulative column interpolated at the bounds of `[startMs, endMs)` (`GPS-060`). */
export function summarizeStretch(series: TrackSeries, heartRate: HeartRateColumns | null, hasElevation: boolean, startMs: number, endMs: number): StretchSummary {
  const from = locateTime(series.t, startMs);
  const to = locateTime(series.t, endMs);
  const delta = (column: Float64Array): number => valueAt(column, to) - valueAt(column, from);
  const movingMs = delta(series.moving);
  const steps = series.steps === null ? null : delta(series.steps);
  const coveredMs = series.heartRateMs === null ? 0 : delta(series.heartRateMs);
  const beats = series.heartBeats === null ? 0 : delta(series.heartBeats);
  return {
    startMs,
    endMs,
    distanceMm: millimeters(delta(series.distance)),
    elapsedMs: Math.round(endMs - startMs),
    movingMs: Math.round(movingMs),
    ascentMm: hasElevation ? millimeters(delta(series.ascent)) : null,
    descentMm: hasElevation ? millimeters(delta(series.descent)) : null,
    gradeAdjustedDistanceMm: series.gradeAdjustedDistance === null ? null : millimeters(delta(series.gradeAdjustedDistance)),
    cadenceAvg: steps === null || movingMs <= 0 ? null : Math.round((steps * 60_000) / movingMs),
    heartRateAvg: coveredMs > 0 ? Math.round((beats * 60_000) / coveredMs) : null,
    heartRateMax: heartRate === null ? null : heartRateMaxBetween(heartRate, startMs, endMs),
  };
}

/**
 * Splits of `splitMeters` of counted distance, bounds interpolated (`GPS-060`, `REC-042`). The last one ends with the activity
 * and keeps its real distance.
 */
export function splitsOf(series: TrackSeries, heartRate: HeartRateColumns | null, hasElevation: boolean, splitMeters: number | null, window: TimeSpan): readonly SplitSummary[] {
  const total = series.distance[series.length - 1] ?? 0;
  if (splitMeters === null || total <= 0) return [];
  const splits: SplitSummary[] = [];
  let startMs = window.startMs;
  let from = 0;
  for (let index = 0; index * splitMeters < total; index += 1) {
    const target = (index + 1) * splitMeters;
    const last = target >= total;
    const at = last ? series.length - 1 : locate(series.distance, target, from);
    const endMs = last ? window.endMs : valueAt(series.t, at);
    splits.push({ index, ...summarizeStretch(series, heartRate, hasElevation, startMs, endMs) });
    startMs = endMs;
    from = at;
  }
  return splits;
}

/** A lap as stored in the `lap` table: offsets in ms since the activity start, the trigger that ended it. */
export interface LapBounds {
  readonly trigger: LapTrigger;
  readonly startOffsetMs: number;
  readonly endOffsetMs: number;
}

export interface LapSummary extends StretchSummary {
  readonly bounds: LapBounds;
}

interface LapBoundary {
  readonly t: number;
  readonly trigger: LapTrigger;
}

/**
 * Lap ends from the `lap` marks and the automatic laps (`REC-040`, `REC-041`). The last lap ends with the activity; it takes
 * the automatic trigger when one is set, `manual` otherwise.
 */
export function recordedLapBounds(series: TrackSeries, marks: readonly TrackerMark[], autoLap: AutoLap, window: TimeSpan): readonly LapBounds[] {
  const lapper = new AutoLapper(autoLap);
  const manual = marks.filter((mark) => mark.kind === "lap" && mark.t > window.startMs && mark.t < window.endMs).map((mark) => mark.t);
  const boundaries: LapBoundary[] = [];
  const autoTrigger = lapper.trigger;
  const point = (index: number): LapPoint => ({ t: series.t[index] ?? 0, distance: series.distance[index] ?? 0, moving: series.moving[index] ?? 0 });
  const pushAuto = (from: LapPoint, to: LapPoint): void => {
    if (autoTrigger === null) return;
    for (const fraction of lapper.advance(from, to)) boundaries.push({ t: between(from, to, fraction).t, trigger: autoTrigger });
  };
  let next = 0;
  for (let index = 1; index < series.length; index += 1) {
    let from = point(index - 1);
    const to = point(index);
    while (next < manual.length && (manual[next] ?? 0) <= to.t) {
      const t = Math.max(manual[next] ?? 0, from.t);
      const at = to.t > from.t ? between(from, to, (t - from.t) / (to.t - from.t)) : to;
      pushAuto(from, at);
      boundaries.push({ t: manual[next] ?? 0, trigger: "manual" });
      lapper.restart(at);
      from = at;
      next += 1;
    }
    pushAuto(from, to);
  }
  for (; next < manual.length; next += 1) boundaries.push({ t: manual[next] ?? 0, trigger: "manual" });
  const lastTrigger: LapTrigger = autoTrigger ?? "manual";
  const bounds: LapBounds[] = [];
  let startMs = window.startMs;
  for (const boundary of [...boundaries, { t: window.endMs, trigger: lastTrigger }]) {
    const endMs = Math.min(Math.round(boundary.t), window.endMs);
    if (endMs <= startMs) continue;
    bounds.push({ trigger: boundary.trigger, startOffsetMs: startMs - window.startMs, endOffsetMs: endMs - window.startMs });
    startMs = endMs;
  }
  return bounds;
}

/** Metrics of each lap; bounds outside the activity are clipped and empty laps dropped. */
export function summarizeLaps(series: TrackSeries, heartRate: HeartRateColumns | null, hasElevation: boolean, bounds: readonly LapBounds[], window: TimeSpan): readonly LapSummary[] {
  const elapsedMs = window.endMs - window.startMs;
  const laps: LapSummary[] = [];
  for (const lap of bounds) {
    const startOffsetMs = Math.max(lap.startOffsetMs, 0);
    const endOffsetMs = Math.min(lap.endOffsetMs, elapsedMs);
    if (endOffsetMs <= startOffsetMs) continue;
    const clipped: LapBounds = { trigger: lap.trigger, startOffsetMs, endOffsetMs };
    laps.push({ bounds: clipped, ...summarizeStretch(series, heartRate, hasElevation, window.startMs + startOffsetMs, window.startMs + endOffsetMs) });
  }
  return laps;
}

/** A `best_effort` row without its session (`PR-001`, `DEC-05`). */
export interface BestEffortResult {
  readonly effort: BestEffortKey;
  /** Elapsed time between the interpolated bounds, pauses included. */
  readonly elapsedMs: number;
  readonly movingMs: number;
  /** Ms since the activity start. */
  readonly startOffsetMs: number;
  /** Ascent of the `ascent_1h` efforts only. */
  readonly ascentMm: number | null;
}

/**
 * Number of ineligible intervals up to each entry: unfilled gaps and the intervals of manual pauses longer than 5 min
 * (`DEC-05`). A window over entries `i..j` is eligible exactly when the counts at `i` and `j` are equal.
 */
export function effortSections(series: TrackSeries, pauses: readonly TimeSpan[]): Uint32Array {
  const sections = new Uint32Array(series.length);
  const long = pauses.filter((pause) => pause.endMs - pause.startMs > bestEffortPauseLimitMs);
  let pause = 0;
  for (let index = 1; index < series.length; index += 1) {
    const end = series.t[index] ?? 0;
    while (pause < long.length && (long[pause]?.endMs ?? 0) < end) pause += 1;
    const span = long[pause];
    const inLongPause = series.interval[index] === intervalCodes.paused && span !== undefined && end > span.startMs;
    sections[index] = (sections[index - 1] ?? 0) + (series.interval[index] === intervalCodes.gap || inLongPause ? 1 : 0);
  }
  return sections;
}

/**
 * Shortest elapsed time over `meters` of counted distance (`PR-001`): two pointers over the cumulative distance, the start
 * interpolated at `d(j) - meters` (`GPS-060`), O(n). `null` when no eligible window covers the distance.
 */
export function bestDistanceEffort(series: TrackSeries, sections: Uint32Array, meters: number, activityStartMs: number): Omit<BestEffortResult, "effort"> | null {
  const { distance, t, moving, length } = series;
  let best: Omit<BestEffortResult, "effort"> | null = null;
  let bestElapsed = Number.POSITIVE_INFINITY;
  let start = 0;
  for (let end = 1; end < length; end += 1) {
    const target = (distance[end] ?? 0) - meters;
    if (target < (distance[0] ?? 0)) continue;
    while ((distance[start + 1] ?? 0) <= target) start += 1;
    if (sections[start] !== sections[end]) continue;
    const low = distance[start] ?? 0;
    const fraction = (target - low) / ((distance[start + 1] ?? 0) - low);
    const startT = valueAt(t, start + fraction);
    const elapsed = (t[end] ?? 0) - startT;
    if (elapsed >= bestElapsed) continue;
    bestElapsed = elapsed;
    best = { elapsedMs: Math.round(elapsed), movingMs: Math.round((moving[end] ?? 0) - valueAt(moving, start + fraction)), startOffsetMs: Math.round(startT - activityStartMs), ascentMm: null };
  }
  return best;
}

/** Largest ascent over `windowMs` of elapsed time, the start interpolated; `null` when no eligible window is that long. */
export function bestAscentEffort(series: TrackSeries, sections: Uint32Array, windowMs: number, activityStartMs: number): Omit<BestEffortResult, "effort"> | null {
  const { ascent, t, moving, length } = series;
  let best: Omit<BestEffortResult, "effort"> | null = null;
  let bestAscent = Number.NEGATIVE_INFINITY;
  let start = 0;
  for (let end = 1; end < length; end += 1) {
    const target = (t[end] ?? 0) - windowMs;
    if (target < (t[0] ?? 0)) continue;
    while ((t[start + 1] ?? 0) <= target) start += 1;
    if (sections[start] !== sections[end]) continue;
    const low = t[start] ?? 0;
    const x = start + (target - low) / ((t[start + 1] ?? 0) - low);
    const climbed = (ascent[end] ?? 0) - valueAt(ascent, x);
    if (climbed <= bestAscent) continue;
    bestAscent = climbed;
    best = { elapsedMs: windowMs, movingMs: Math.round((moving[end] ?? 0) - valueAt(moving, x)), startOffsetMs: Math.round(target - activityStartMs), ascentMm: millimeters(climbed) };
  }
  return best;
}

/** Best efforts of the profile's distances, and the best ascent in 1 h for the sports that rank it (`PR-001`, `DEC-05`). */
export function bestEffortsOf(series: TrackSeries, pauses: readonly TimeSpan[], sport: SportKey, profile: RecordingProfile, hasElevation: boolean, activityStartMs: number): readonly BestEffortResult[] {
  const sections = effortSections(series, pauses);
  const efforts: BestEffortResult[] = [];
  for (const meters of profile.bestEffortMeters) {
    const effort = bestDistanceEffort(series, sections, meters, activityStartMs);
    if (effort !== null) efforts.push({ effort: `${sport}:distance:${meters}`, ...effort });
  }
  if (profile.bestAscentWindowMs !== null && hasElevation) {
    const effort = bestAscentEffort(series, sections, profile.bestAscentWindowMs, activityStartMs);
    if (effort !== null) efforts.push({ effort: `${sport}:ascent_1h`, ...effort });
  }
  return efforts;
}

/** `GPS-062`, on top of the profile's minimum D+. */
export const trackClimbRules = {
  minimumGrade: 0.03,
  /** Climbs separated by less flat than this are one climb. */
  mergeMeters: 300,
  /** A flat between two climbs loses at most this altitude, otherwise it is a descent and keeps them apart. */
  flatDropMeters: 10,
  edgeRunMeters: 5,
  /** The altitude is resampled at this step of counted distance: each step climbs or not, and climbs start and end on steps. */
  stepMeters: 50,
  /** The maximum grade is the steepest mean over this length, so a single noisy step does not make it. */
  maxGradeMeters: 100,
} as const;

/** A climb of an activity (`GPS-062`). */
export interface TrackClimb {
  /** Counted distance from the activity start to the foot of the climb. */
  readonly startDistanceMm: number;
  readonly distanceMm: number;
  /** From the hysteresis automaton, like the activity's D+ (`ELE-010`). */
  readonly ascentMm: number;
  /** Net altitude gain over the length, as a fraction. */
  readonly gradeAvg: number;
  readonly gradeMax: number;
  readonly movingMs: number;
  /** D+ over the moving time, m/h; null without moving time. */
  readonly vamMetersPerHour: number | null;
}

interface StepRun {
  /** Step indices of the foot and the top. */
  readonly from: number;
  readonly to: number;
}

/** The smoothed altitude every `stepMeters` of counted distance, `NaN` before the first known altitude. */
function resampledAltitude(series: TrackSeries): Float64Array {
  const { length, distance, altitude } = series;
  const heights = new Float64Array(Math.floor((distance[length - 1] ?? 0) / trackClimbRules.stepMeters) + 1).fill(Number.NaN);
  const known = (index: number): boolean => !Number.isNaN(altitude[index] ?? Number.NaN);
  let low = -1;
  let high = 0;
  for (let step = 0; step < heights.length; step += 1) {
    const target = step * trackClimbRules.stepMeters;
    for (; high < length && (!known(high) || (distance[high] ?? 0) < target); high += 1) if (known(high)) low = high;
    if (high >= length) break;
    const highDistance = distance[high] ?? 0;
    const highAltitude = altitude[high] ?? 0;
    if (highDistance === target) heights[step] = highAltitude;
    else if (low >= 0) {
      const lowDistance = distance[low] ?? 0;
      const lowAltitude = altitude[low] ?? 0;
      heights[step] = lowAltitude + ((highAltitude - lowAltitude) * (target - lowDistance)) / (highDistance - lowDistance);
    }
  }
  return heights;
}

function isFlatBetween(heights: Float64Array, before: StepRun, after: StepRun): boolean {
  if ((after.from - before.to) * trackClimbRules.stepMeters >= trackClimbRules.mergeMeters) return false;
  const top = heights[before.to] ?? Number.NaN;
  let lowest = top;
  for (let step = before.to; step <= after.from; step += 1) lowest = Math.min(lowest, heights[step] ?? Number.NaN);
  return top - lowest <= trackClimbRules.flatDropMeters;
}

const gainOf = (heights: Float64Array, run: StepRun): number => (heights[run.to] ?? 0) - (heights[run.from] ?? 0);

/**
 * Runs of climbing steps, merged across short flats that lose little altitude. A merged climb does not start or end with a run
 * gaining less than `edgeRunMeters`: that is altitude noise on the flat around it.
 */
function climbingRuns(heights: Float64Array): readonly StepRun[] {
  const runs: StepRun[] = [];
  for (let step = 0; step + 1 < heights.length; step += 1) {
    const rise = (heights[step + 1] ?? Number.NaN) - (heights[step] ?? Number.NaN);
    if (!(rise >= trackClimbRules.minimumGrade * trackClimbRules.stepMeters)) continue;
    const previous = runs.at(-1);
    if (previous !== undefined && previous.to === step) runs[runs.length - 1] = { from: previous.from, to: step + 1 };
    else runs.push({ from: step, to: step + 1 });
  }
  const groups: StepRun[][] = [];
  for (const run of runs) {
    const group = groups.at(-1);
    const last = group?.at(-1);
    if (group !== undefined && last !== undefined && isFlatBetween(heights, last, run)) group.push(run);
    else groups.push([run]);
  }
  return groups.map((group) => {
    const gains = group.map((run) => gainOf(heights, run));
    let first = 0;
    let last = group.length - 1;
    while (first < last && (gains[first] ?? 0) < trackClimbRules.edgeRunMeters) first += 1;
    while (last > first && (gains[last] ?? 0) < trackClimbRules.edgeRunMeters) last -= 1;
    return { from: group[first]?.from ?? 0, to: group[last]?.to ?? 0 };
  });
}

function steepestGrade(heights: Float64Array, run: StepRun): number {
  const span = Math.min(Math.round(trackClimbRules.maxGradeMeters / trackClimbRules.stepMeters), run.to - run.from);
  let steepest = Number.NEGATIVE_INFINITY;
  for (let step = run.from; step + span <= run.to; step += 1) steepest = Math.max(steepest, ((heights[step + span] ?? 0) - (heights[step] ?? 0)) / (span * trackClimbRules.stepMeters));
  return steepest;
}

/**
 * `GPS-062`: stretches of mean grade at least 3 % and D+ at least `minimumAscentMeters`, climbs separated by less than
 * 300 m of flat merged, measured on the series columns at their interpolated bounds (`GPS-060`). O(n).
 */
export function trackClimbsOf(series: TrackSeries, minimumAscentMeters: number): readonly TrackClimb[] {
  const heights = resampledAltitude(series);
  const climbs: TrackClimb[] = [];
  let from = 0;
  for (const run of climbingRuns(heights)) {
    const meters = (run.to - run.from) * trackClimbRules.stepMeters;
    const gradeAvg = ((heights[run.to] ?? 0) - (heights[run.from] ?? 0)) / meters;
    if (gradeAvg < trackClimbRules.minimumGrade) continue;
    const start = locate(series.distance, run.from * trackClimbRules.stepMeters, from);
    const end = locate(series.distance, run.to * trackClimbRules.stepMeters, start);
    from = end;
    const ascent = valueAt(series.ascent, end) - valueAt(series.ascent, start);
    if (ascent < minimumAscentMeters) continue;
    const movingMs = valueAt(series.moving, end) - valueAt(series.moving, start);
    climbs.push({
      startDistanceMm: millimeters(run.from * trackClimbRules.stepMeters),
      distanceMm: millimeters(meters),
      ascentMm: millimeters(ascent),
      gradeAvg,
      gradeMax: Math.max(steepestGrade(heights, run), gradeAvg),
      movingMs: Math.round(movingMs),
      vamMetersPerHour: movingMs > 0 ? Math.round((ascent * 3_600_000) / movingMs) : null,
    });
  }
  return climbs;
}

/** Highest mean of the smoothed speed over a centered 3 s window of counted intervals (`speed_max`), O(n). */
export function maxWindowSpeed(series: Pick<TrackSeries, "length" | "t" | "speed" | "interval">): number | null {
  const { t, speed, interval, length } = series;
  const half = maxSpeedWindowMs / 2;
  const counted = (index: number): boolean => index > 0 && isCountedCode(interval[index] ?? 0);
  let low = 0;
  let high = 0;
  let sum = 0;
  let count = 0;
  let max: number | null = null;
  for (let index = 1; index < length; index += 1) {
    const center = t[index] ?? 0;
    for (; high < length && (t[high] ?? 0) <= center + half; high += 1) {
      if (!counted(high)) continue;
      sum += speed[high] ?? 0;
      count += 1;
    }
    for (; (t[low] ?? 0) < center - half; low += 1) {
      if (!counted(low)) continue;
      sum -= speed[low] ?? 0;
      count -= 1;
    }
    if (!counted(index)) continue;
    const mean = sum / count;
    if (max === null || mean > max) max = mean;
  }
  return max;
}
