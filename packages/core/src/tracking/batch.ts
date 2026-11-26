import type { ElevationSource } from "@obnixe/schema";
import type { Track } from "./codec/track.ts";
import { ellipsoidDistance } from "./geo.ts";
import { SignalPipeline } from "./pipeline.ts";
import type { SettledFix } from "./pipeline.ts";
import type { ResolvedProfile } from "./profile.ts";
import { distanceMovingAverage, ElevationHysteresis, elevationThresholdMeters, gnssAltitudeFilter, gradeSeries, VamMeter, verticalSigma, VerticalSpeedMeter } from "./stages/altitude.ts";
import {
  accumulateHeartRate,
  bestEffortsOf,
  countedSpans,
  gradeAdjustmentFactor,
  intervalCodes,
  intervalKind,
  isCountedCode,
  motionIntervals,
  PauseLedger,
  recordedLapBounds,
  splitsOf,
  summarizeLaps,
} from "./stages/derive.ts";
import type { AutoLap, BestEffortResult, LapBounds, LapSummary, MotionInterval, SplitSummary, TrackSeries } from "./stages/derive.ts";
import { classifyIntervals, motionVerticalSpeedWindowMs } from "./stages/motion.ts";
import type { MotionInput } from "./stages/motion.ts";
import { absentValue } from "./types.ts";
import type { Fix, FixColumns, SampleColumns, TrackerMark } from "./types.ts";
import { accuracyShares, summarizeRecording } from "./summary.ts";
import type { RecordingSummary, TrackDetails } from "./summary.ts";
import { trackingAlgorithmVersion } from "./version.ts";
import type { TimeSpan } from "./zones.ts";

/** Laps recorded with the activity (marks and automatic laps), or laps already stored or imported, re-measured as they are. */
export type LapSource = { readonly kind: "recorded"; readonly autoLap: AutoLap } | { readonly kind: "given"; readonly laps: readonly LapBounds[] };

/** The `recording.trim_start_ms` and `trim_end_ms` columns, on the time base of the samples. */
export interface TrackTrim {
  readonly startMs: number;
  readonly endMs: number | null;
}

export interface ProcessOptions {
  readonly laps: LapSource;
  readonly trim: TrackTrim;
}

/** Everything the detail of an activity and its rows derive from (`GPS-001`); times on the time base of the samples. */
export interface ProcessedTrack {
  readonly algorithmVersion: number;
  /** The activity after trimming: lap and best-effort offsets count from its start. */
  readonly elapsed: TimeSpan;
  readonly series: TrackSeries;
  readonly intervals: readonly MotionInterval[];
  /** Counted intervals, sorted and disjoint: the moving time of `estimateEnergy` and `timeInZones`. */
  readonly moving: readonly TimeSpan[];
  readonly pauses: readonly TimeSpan[];
  readonly summary: RecordingSummary;
  readonly details: TrackDetails;
  readonly splits: readonly SplitSummary[];
  readonly laps: readonly LapSummary[];
  readonly bestEfforts: readonly BestEffortResult[];
}

const orNull = (value: number): number | null => (value === absentValue ? null : value);

function fixAt(fixes: FixColumns, index: number): Fix {
  return {
    type: "fix",
    t: fixes.t[index] ?? 0,
    fixAgeMs: fixes.fixAgeMs[index] ?? 0,
    latitudeE7: fixes.latitudeE7[index] ?? 0,
    longitudeE7: fixes.longitudeE7[index] ?? 0,
    altitudeEllipsoidMm: orNull(fixes.altitudeEllipsoidMm[index] ?? absentValue),
    altitudeMslMm: orNull(fixes.altitudeMslMm[index] ?? absentValue),
    horizontalAccuracyDm: orNull(fixes.horizontalAccuracyDm[index] ?? absentValue),
    verticalAccuracyDm: orNull(fixes.verticalAccuracyDm[index] ?? absentValue),
    speedCmS: orNull(fixes.speedCmS[index] ?? absentValue),
    speedAccuracyCmS: orNull(fixes.speedAccuracyCmS[index] ?? absentValue),
    bearingCentiDeg: orNull(fixes.bearingCentiDeg[index] ?? absentValue),
    bearingAccuracyCentiDeg: orNull(fixes.bearingAccuracyCentiDeg[index] ?? absentValue),
    simulated: fixes.simulated[index] === 1,
  };
}

/** The recorded window: from the trim start to the trim end, or to the last stop, or to the last sample or mark. */
export function activityWindow(samples: SampleColumns, marks: readonly TrackerMark[], trim: TrackTrim): TimeSpan {
  if (trim.endMs !== null) return { startMs: trim.startMs, endMs: trim.endMs };
  let endMs = trim.startMs;
  for (const mark of marks) if (mark.kind === "stop") endMs = mark.t;
  if (endMs > trim.startMs) return { startMs: trim.startMs, endMs };
  for (const stream of [samples.fixes, samples.pressure, samples.steps, samples.heartRate]) if (stream.length > 0) endMs = Math.max(endMs, stream.t[stream.length - 1] ?? 0);
  for (const mark of marks) endMs = Math.max(endMs, mark.t);
  return { startMs: trim.startMs, endMs };
}

/** Feeds the window's samples to the stages 2 to 4 in time order, pressure and steps before a fix of the same instant. */
function settleFixes(pipeline: SignalPipeline, samples: SampleColumns, window: TimeSpan): readonly SettledFix[] {
  const { fixes, pressure, steps } = samples;
  const settled: SettledFix[] = [];
  const inWindow = (t: number): boolean => t >= window.startMs && t <= window.endMs;
  let pressureIndex = 0;
  let stepIndex = 0;
  const drain = (until: number): void => {
    for (; pressureIndex < pressure.length && (pressure.t[pressureIndex] ?? 0) <= until; pressureIndex += 1) {
      const t = pressure.t[pressureIndex] ?? 0;
      if (inWindow(t)) pipeline.pushPressure({ type: "pressure", t, pascals: pressure.pascals[pressureIndex] ?? 0 });
    }
    for (; stepIndex < steps.length && (steps.t[stepIndex] ?? 0) <= until; stepIndex += 1) {
      const t = steps.t[stepIndex] ?? 0;
      if (inWindow(t)) pipeline.pushSteps({ type: "steps", t, count: steps.count[stepIndex] ?? 0 });
    }
  };
  for (let index = 0; index < fixes.length; index += 1) {
    const t = fixes.t[index] ?? 0;
    drain(t);
    if (inWindow(t)) settled.push(...pipeline.pushFix(fixAt(fixes, index), index));
  }
  settled.push(...pipeline.flush());
  return settled;
}

/** Cumulative pedometer count at increasing times, linearly interpolated between samples. */
function stepCounter(samples: SampleColumns): (t: number) => number {
  const { t: times, count, length } = samples.steps;
  let index = 0;
  return (t: number): number => {
    while (index + 1 < length && (times[index + 1] ?? 0) <= t) index += 1;
    const low = times[index] ?? 0;
    const high = times[index + 1] ?? low;
    const value = count[index] ?? 0;
    if (t <= low || high === low) return value;
    return value + (((count[index + 1] ?? value) - value) * (t - low)) / (high - low);
  };
}

/**
 * Stages 2 to 9 over a whole track (`GPS-001`): the reference computation of an activity, deterministic for a given track,
 * profile and `trackingAlgorithmVersion` (`GPS-002`), O(n) in the number of samples.
 */
export function processTrack(track: Track, profile: ResolvedProfile, options: ProcessOptions): ProcessedTrack {
  const { samples, marks } = track;
  const window = activityWindow(samples, marks, options.trim);
  const pipeline = new SignalPipeline(profile, { altitudeSmoothing: true });
  const settled = settleFixes(pipeline, samples, window);
  const smoothed = pipeline.trace.smoothRts();
  if (smoothed.length !== settled.length) throw new Error("Kalman trace and settled fixes diverge");
  const length = smoothed.length;
  const barometer = pipeline.hasBarometer;
  const ledger = new PauseLedger();
  for (const mark of marks) ledger.mark(mark);

  const motionVerticalSpeed = new VerticalSpeedMeter(motionVerticalSpeedWindowMs);
  const speed = new Float32Array(length);
  const inputs: MotionInput[] = [];
  for (let index = 0; index < length; index += 1) {
    const fix = settled[index];
    if (fix === undefined) continue;
    const t = smoothed.t[index] ?? 0;
    speed[index] = Math.hypot(smoothed.velocityEast[index] ?? 0, smoothed.velocityNorth[index] ?? 0);
    inputs.push({
      t,
      speed: speed[index] ?? 0,
      verticalSpeed: barometer && fix.fusedAltitude !== null ? motionVerticalSpeed.push(t, fix.fusedAltitude) : null,
      cadence: fix.cadence,
      accuracy: fix.fix.horizontalAccuracyDm === null ? null : fix.fix.horizontalAccuracyDm / 10,
      paused: ledger.isPaused(t),
    });
  }
  const states = classifyIntervals(profile.motion, inputs);

  const interval = new Uint8Array(length);
  const distance = new Float64Array(length);
  const moving = new Float64Array(length);
  const steps = pipeline.hasPedometer ? new Float64Array(length) : null;
  const countAt = stepCounter(samples);
  let previousCount = countAt(smoothed.t[0] ?? 0);
  for (let index = 1; index < length; index += 1) {
    const durationMs = (smoothed.t[index] ?? 0) - (smoothed.t[index - 1] ?? 0);
    const meters = ellipsoidDistance(smoothed.latitude[index - 1] ?? 0, smoothed.longitude[index - 1] ?? 0, smoothed.latitude[index] ?? 0, smoothed.longitude[index] ?? 0);
    const kind = intervalKind({ durationMs, meters, restart: smoothed.restart[index] === 1, paused: inputs[index]?.paused ?? false, moving: states[index] === 1 }, profile);
    const code = intervalCodes[kind];
    const counted = isCountedCode(code);
    interval[index] = code;
    distance[index] = (distance[index - 1] ?? 0) + (counted ? meters : 0);
    moving[index] = (moving[index - 1] ?? 0) + (counted ? durationMs : 0);
    if (steps !== null) {
      const count = countAt(smoothed.t[index] ?? 0);
      steps[index] = (steps[index - 1] ?? 0) + (counted ? count - previousCount : 0);
      previousCount = count;
    }
  }

  const altitude = new Float64Array(length).fill(Number.NaN);
  let elevationSource: ElevationSource = "none";
  if (barometer) {
    const fused = pipeline.fusion.smoothRts();
    settled.forEach((fix, index) => {
      if (fix.fusedIndex >= 0) altitude[index] = fused[fix.fusedIndex] ?? Number.NaN;
    });
    if (fused.length > 0) elevationSource = "barometer";
  } else {
    const filter = gnssAltitudeFilter({ smoothing: true });
    const known: number[] = [];
    settled.forEach((fix, index) => {
      if (fix.gnssAltitude === null) return;
      filter.push(fix.fix.t, fix.gnssAltitude, verticalSigma(fix.fix));
      known.push(index);
    });
    if (known.length > 0) {
      const averaged = distanceMovingAverage(Float64Array.from(known, (index) => distance[index] ?? 0), filter.smoothRts());
      known.forEach((index, position) => (altitude[index] = averaged[position] ?? Number.NaN));
      elevationSource = "gnss";
    }
  }

  const countedFlags = interval.map((code) => (isCountedCode(code) ? 1 : 0));
  const grade = gradeSeries(distance, altitude, countedFlags);
  const ascent = new Float64Array(length);
  const descent = new Float64Array(length);
  const gradeAdjusted = profile.gradeAdjustedPace ? new Float64Array(length) : null;
  const hysteresis = new ElevationHysteresis(barometer ? elevationThresholdMeters.barometer : elevationThresholdMeters.gnss);
  const vam = new VamMeter();
  for (let index = 0; index < length; index += 1) {
    const value = altitude[index] ?? Number.NaN;
    if (!Number.isNaN(value)) hysteresis.push(value, countedFlags[index] === 1);
    ascent[index] = hysteresis.ascent;
    descent[index] = hysteresis.descent;
    if (index === 0) continue;
    vam.push((smoothed.t[index] ?? 0) - (smoothed.t[index - 1] ?? 0), hysteresis.ascent - (ascent[index - 1] ?? 0), grade[index] ?? Number.NaN, countedFlags[index] === 1);
    if (gradeAdjusted !== null) gradeAdjusted[index] = (gradeAdjusted[index - 1] ?? 0) + ((distance[index] ?? 0) - (distance[index - 1] ?? 0)) * gradeAdjustmentFactor(grade[index] ?? Number.NaN);
  }

  const partial = { length, t: smoothed.t, interval };
  const heartRate = samples.heartRate.length > 0 ? samples.heartRate : null;
  const accumulated = heartRate === null ? null : accumulateHeartRate(partial, heartRate);
  const series: TrackSeries = {
    length,
    t: smoothed.t,
    fixIndex: Uint32Array.from(settled, (fix) => Math.max(fix.tag, 0)),
    latitude: smoothed.latitude,
    longitude: smoothed.longitude,
    speed,
    altitude: Float32Array.from(altitude),
    grade,
    interval,
    distance,
    moving,
    ascent,
    descent,
    gradeAdjustedDistance: gradeAdjusted,
    steps,
    heartBeats: accumulated?.beats ?? null,
    heartRateMs: accumulated?.coveredMs ?? null,
  };

  const intervals = motionIntervals(series);
  const pauses = ledger.spans(window);
  const hasElevation = elevationSource !== "none";
  const summary = summarizeRecording({ series, samples, window, elevationSource, simulated: pipeline.simulated });
  const lapBounds = options.laps.kind === "recorded" ? recordedLapBounds(series, marks, options.laps.autoLap, window) : options.laps.laps;
  const coveredMs = series.heartRateMs?.[length - 1] ?? 0;
  return {
    algorithmVersion: trackingAlgorithmVersion,
    elapsed: window,
    series,
    intervals,
    moving: countedSpans(intervals),
    pauses,
    summary,
    details: {
      gradeAdjustedDistanceMm: gradeAdjusted === null ? null : Math.round((gradeAdjusted[length - 1] ?? 0) * 1000),
      vamMetersPerHour: hasElevation ? vam.value : null,
      preciseFixPermille: accuracyShares(series, samples.fixes).precisePermille,
      heartRateCoveragePermille: heartRate === null || summary.movingMs <= 0 ? null : Math.round((coveredMs * 1000) / summary.movingMs),
      gateRejections: pipeline.gateRejections,
      outlierRejections: pipeline.outlierRejections,
    },
    splits: splitsOf(series, heartRate, hasElevation, profile.splitMeters, window),
    laps: summarizeLaps(series, heartRate, hasElevation, lapBounds, window),
    bestEfforts: bestEffortsOf(series, pauses, profile.sport, profile, hasElevation, window.startMs),
  };
}
