import type { MetricKey } from "@obnixe/schema";
import { ellipsoidDistance } from "./geo.ts";
import { SignalPipeline } from "./pipeline.ts";
import type { SettledFix } from "./pipeline.ts";
import type { ResolvedProfile } from "./profile.ts";
import { ElevationHysteresis, elevationThresholdMeters, gnssAltitudeFilter, GradeMeter, VamMeter, verticalSigma, VerticalSpeedMeter } from "./stages/altitude.ts";
import type { ScalarKalman } from "./stages/altitude.ts";
import { AutoLapper, gradeAdjustmentFactor, intervalKind, isCounted, PauseLedger, slowestPaceSecondsPerKm, SpeedSmoother } from "./stages/derive.ts";
import type { AutoLap, LapPoint, MotionIntervalKind } from "./stages/derive.ts";
import { MotionClassifier, motionVerticalSpeedWindowMs } from "./stages/motion.ts";
import type { MotionState } from "./stages/motion.ts";
import type { HeartRateSample, Sample, TrackerMark } from "./types.ts";
import { heartRateHoldMs, isHeartRateReading } from "./zones.ts";

/** Lag of the fixed-lag smoother whose positions measure the committed distance. */
export const liveSmoothingSteps = 40;
/** A new display point is at least this far from the last one (`GPS-071`). */
export const displayStepMeters = 2;
/** Without a fix for this long the signal is lost. */
export const signalTimeoutMs = 10_000;
/** Upper bounds in meters of the horizontal accuracy of each signal level. */
export const signalLevelAccuracy = { good: 8, fair: 20, weak: 50 } as const;

export type SignalLevel = "none" | "weak" | "fair" | "good";

export function signalLevelOf(accuracy: number | null): SignalLevel {
  if (accuracy === null || accuracy > signalLevelAccuracy.weak) return "none";
  if (accuracy > signalLevelAccuracy.fair) return "weak";
  return accuracy > signalLevelAccuracy.good ? "fair" : "good";
}

/** Recorder events raised by the tracker (`REC-030`, `REC-041`); an automatic lap is an alert, never a journal mark. */
export type LiveEvent =
  | { readonly type: "motion_started"; readonly t: number }
  | { readonly type: "motion_stopped"; readonly t: number }
  | { readonly type: "lap"; readonly trigger: "distance" | "duration"; readonly t: number };

/** A point of the live map; `dashed` when the segment from the previous point crosses a pause or an unfilled gap. */
export interface LivePoint {
  readonly t: number;
  readonly latitude: number;
  readonly longitude: number;
  readonly dashed: boolean;
}

export interface LiveLap {
  /** From 0. */
  readonly index: number;
  readonly startMs: number;
  readonly elapsedMs: number;
  readonly movingMs: number;
  readonly distanceMm: number;
}

export interface LiveSignal {
  readonly level: SignalLevel;
  /** Horizontal accuracy in meters of the latest fix. */
  readonly accuracy: number | null;
}

/**
 * Values of the profile's metrics that have one. Units: ms for times, meters for distances and altitudes, seconds per
 * `pacePerMeters` for paces (instant ones rounded to the second, `GPS-035`), m/s for speeds and the vertical speed, a fraction for the grade, m/h for the VAM, steps per
 * minute, bpm, and meters of accuracy for `gps_quality`. `heart_rate_zone`, `energy` and `clock` belong to the host.
 */
export type LiveMetrics = Readonly<Partial<Record<MetricKey, number>>>;

export interface LiveSnapshot {
  readonly t: number;
  readonly motion: MotionState;
  readonly elapsedMs: number;
  readonly movingMs: number;
  readonly distanceMm: number;
  readonly lap: LiveLap;
  readonly metrics: LiveMetrics;
  readonly signal: LiveSignal;
  readonly position: { readonly latitude: number; readonly longitude: number } | null;
}

/** An interval whose motion state may still be backdated by the classifier. */
interface PendingInterval {
  readonly startMs: number;
  readonly endMs: number;
  readonly restart: boolean;
  readonly paused: boolean;
  state: MotionState;
  readonly altitude: number | null;
  /** Kalman trace step of the interval's end. */
  readonly step: number;
  /** Replaced by the distance between the lagged smoothed positions, before the interval can be committed. */
  meters: number;
  smoothed: boolean;
}

/** Heart-rate readings since the last committed interval, integrated with the batch hold rule (`forEachHeartRateSpan`). */
class HeartRateLedger {
  private times: number[] = [];
  private rates: number[] = [];
  beats = 0;
  coveredMs = 0;

  push(sample: HeartRateSample): void {
    this.times.push(sample.t);
    this.rates.push(sample.bpm);
  }

  /** Adds the held readings over `[startMs, endMs)`; every reading up to `endMs` must have been pushed. */
  integrate(startMs: number, endMs: number): void {
    for (let index = 0; index < this.times.length; index += 1) {
      const at = this.times[index] ?? 0;
      if (at >= endMs) break;
      const rate = this.rates[index] ?? 0;
      if (!isHeartRateReading(rate)) continue;
      const next = this.times[index + 1] ?? Number.POSITIVE_INFINITY;
      const overlap = Math.min(next, at + heartRateHoldMs, endMs) - Math.max(at, startMs);
      if (overlap <= 0) continue;
      this.beats += (rate * overlap) / 60_000;
      this.coveredMs += overlap;
    }
  }

  /** Drops the readings that no longer hold at `beforeMs`. */
  prune(beforeMs: number): void {
    let keep = 0;
    while (keep + 1 < this.times.length && (this.times[keep + 1] ?? 0) <= beforeMs) keep += 1;
    if (keep === 0) return;
    this.times = this.times.slice(keep);
    this.rates = this.rates.slice(keep);
  }
}

interface Totals {
  readonly distance: number;
  readonly moving: number;
}

/**
 * Stream mode of the stages 2 to 8 (`GPS-001`), O(1) amortized per sample (`PRF-030`): the same stages and interval rules as
 * `processTrack` without the backward passes. Intervals stay pending while a classifier switch may still backdate them, so
 * the counted distance converges to the batch one (`GPS-032`).
 */
export class LiveTracker {
  private readonly profile: ResolvedProfile;
  private readonly pipeline: SignalPipeline;
  private readonly classifier: MotionClassifier;
  private readonly ledger = new PauseLedger();
  private readonly lapper: AutoLapper;
  private readonly backdateMs: number;
  private readonly speed: SpeedSmoother;
  private readonly motionVerticalSpeed = new VerticalSpeedMeter(motionVerticalSpeedWindowMs);
  private readonly verticalSpeed = new VerticalSpeedMeter();
  private readonly gradeMeter = new GradeMeter();
  private readonly vam = new VamMeter();
  private readonly gnssAltitude: ScalarKalman = gnssAltitudeFilter({ smoothing: false });
  private readonly heartRate = new HeartRateLedger();
  private hysteresis: ElevationHysteresis | null = null;
  private pending: PendingInterval[] = [];
  private previous: SettledFix | null = null;
  private settledSteps = 0;
  private nextSmoothedStep = 0;
  private lastSmoothed: { readonly latitude: number; readonly longitude: number } | null = null;
  private startMs = 0;
  private distance = 0;
  private moving = 0;
  private gradeAdjustedDistance = 0;
  private started = false;
  private grade: number | null = null;
  private altitude: number | null = null;
  private altitudeMin = Number.POSITIVE_INFINITY;
  private altitudeMax = Number.NEGATIVE_INFINITY;
  private verticalSpeedNow: number | null = null;
  private speedNow = 0;
  private speedMax: number | null = null;
  private lapIndex = 0;
  private lapStart: LapPoint = { t: 0, distance: 0, moving: 0 };
  private lastPoint: LapPoint = { t: 0, distance: 0, moving: 0 };
  private completed: readonly LiveLap[] = [];
  private firstStepCount: number | null = null;
  private lastStepCount: number | null = null;
  private latestReading: HeartRateSample | null = null;
  private heartRateMax: number | null = null;
  private lastFixT: number | null = null;
  private lastAccuracy: number | null = null;
  private displayed: LivePoint | null = null;
  private dashedSinceDisplay = false;
  private track: LivePoint[] = [];

  constructor(profile: ResolvedProfile, autoLap: AutoLap) {
    this.profile = profile;
    this.pipeline = new SignalPipeline(profile, { altitudeSmoothing: false });
    this.classifier = new MotionClassifier(profile.motion);
    this.lapper = new AutoLapper(autoLap);
    this.backdateMs = Math.max(profile.motion.startAfterMs, profile.motion.stopAfterMs);
    this.speed = new SpeedSmoother(profile.speedSmoothingMs);
  }

  get motion(): MotionState {
    return this.classifier.state;
  }

  /** Takes one sample of the journal, in journal order, and returns the events it raised (`PRF-010`). */
  push(sample: Sample): readonly LiveEvent[] {
    switch (sample.type) {
      case "fix": {
        this.lastFixT = sample.t;
        this.lastAccuracy = sample.horizontalAccuracyDm === null ? null : sample.horizontalAccuracyDm / 10;
        const settledFixes = this.pipeline.pushFix(sample, 0);
        if (settledFixes.length === 0) return [];
        const events: LiveEvent[] = [];
        for (const settled of settledFixes) this.settle(settled, events);
        this.smoothLagged();
        const t = this.previous?.estimate.t ?? sample.t;
        this.commit(t - this.backdateMs);
        this.advanceLaps(t, events);
        return events;
      }
      case "pressure":
        this.pipeline.pushPressure(sample);
        return [];
      case "steps":
        this.pipeline.pushSteps(sample);
        this.firstStepCount ??= sample.count;
        this.lastStepCount = sample.count;
        return [];
      case "heart_rate":
        this.heartRate.push(sample);
        this.latestReading = isHeartRateReading(sample.bpm) ? sample : null;
        if (this.latestReading !== null && (this.heartRateMax === null || sample.bpm > this.heartRateMax)) this.heartRateMax = sample.bpm;
        return [];
      default: {
        const unreachable: never = sample;
        throw new Error(`Unhandled sample ${JSON.stringify(unreachable)}`);
      }
    }
  }

  /** Takes a journal mark: pauses change the classification, a manual lap restarts the automatic count (`REC-040`). */
  mark(mark: TrackerMark): void {
    this.ledger.mark(mark);
    if (mark.kind === "start" && !this.started) {
      this.started = true;
      this.startMs = mark.t;
      this.lapStart = { ...this.lapStart, t: mark.t };
    }
    if (mark.kind !== "lap") return;
    const at: LapPoint = { ...this.lastPoint, t: mark.t };
    this.lapper.restart(at);
    this.closeLap(at);
  }

  /** Finished laps, oldest first; a new array after each lap (`REC-040`, `REC-041`). */
  get laps(): readonly LiveLap[] {
    return this.completed;
  }

  /** Display points added since the previous call (`GPS-071`). */
  takeTrack(): readonly LivePoint[] {
    const points = this.track;
    this.track = [];
    return points;
  }

  snapshot(now: number): LiveSnapshot {
    const totals = this.totals();
    const motion = this.classifier.state;
    const accuracy = this.lastFixT !== null && now - this.lastFixT <= signalTimeoutMs ? this.lastAccuracy : null;
    const lap: LiveLap = {
      index: this.lapIndex,
      startMs: this.lapStart.t,
      elapsedMs: Math.max(now - this.lapStart.t, 0),
      movingMs: Math.round(totals.moving - this.lapStart.moving),
      distanceMm: Math.round((totals.distance - this.lapStart.distance) * 1000),
    };
    const estimate = this.previous?.estimate ?? null;
    return {
      t: now,
      motion,
      elapsedMs: Math.max(now - this.startMs, 0),
      movingMs: Math.round(totals.moving),
      distanceMm: Math.round(totals.distance * 1000),
      lap,
      metrics: this.metrics(now, totals, lap, accuracy),
      signal: { level: signalLevelOf(accuracy), accuracy },
      position: estimate === null ? null : { latitude: estimate.latitude, longitude: estimate.longitude },
    };
  }

  private settle(settled: SettledFix, events: LiveEvent[]): void {
    const t = settled.estimate.t;
    const previous = this.previous;
    this.previous = settled;
    const altitude = this.liveAltitude(settled);
    const paused = this.ledger.isPaused(t);
    const speed = Math.hypot(settled.estimate.velocityEast, settled.estimate.velocityNorth);
    const before = this.classifier.state;
    const state = this.classifier.push({
      t,
      speed,
      verticalSpeed: this.pipeline.hasBarometer && settled.fusedAltitude !== null ? this.motionVerticalSpeed.push(t, settled.fusedAltitude) : null,
      cadence: settled.cadence,
      accuracy: settled.fix.horizontalAccuracyDm === null ? null : settled.fix.horizontalAccuracyDm / 10,
      paused,
    });
    if (state !== before) {
      const since = this.classifier.since ?? t;
      for (const interval of this.pending) if (interval.startMs >= since) interval.state = state;
      events.push({ type: state === "moving" ? "motion_started" : "motion_stopped", t: since });
    }
    const smoothedSpeed = this.speed.push(t, speed);
    this.speedNow = state === "moving" ? smoothedSpeed : 0;
    if (state === "moving" && (this.speedMax === null || this.speedNow > this.speedMax)) this.speedMax = this.speedNow;
    if (altitude !== null) {
      this.altitude = altitude;
      this.altitudeMin = Math.min(this.altitudeMin, altitude);
      this.altitudeMax = Math.max(this.altitudeMax, altitude);
      this.verticalSpeedNow = this.verticalSpeed.push(t, altitude);
    }
    const step = this.settledSteps;
    this.settledSteps += 1;
    if (previous === null) return;
    const meters = ellipsoidDistance(previous.estimate.latitude, previous.estimate.longitude, settled.estimate.latitude, settled.estimate.longitude);
    const interval: PendingInterval = { startMs: previous.estimate.t, endMs: t, restart: settled.reset, paused, state, altitude, step, meters, smoothed: false };
    this.pending.push(interval);
    this.display(settled, this.kindOf(interval));
  }

  /** Measures the pending intervals on the positions smoothed `liveSmoothingSteps` steps back (`GPS-031`, `GPS-032`). */
  private smoothLagged(): void {
    const trace = this.pipeline.trace;
    const target = trace.length - 1 - liveSmoothingSteps;
    if (target < this.nextSmoothedStep) return;
    const window = trace.smoothSince(this.nextSmoothedStep);
    const firstPending = this.pending[0]?.step ?? Number.POSITIVE_INFINITY;
    for (let step = this.nextSmoothedStep; step <= target; step += 1) {
      const latitude = window.latitude[step - this.nextSmoothedStep] ?? 0;
      const longitude = window.longitude[step - this.nextSmoothedStep] ?? 0;
      const interval = this.pending[step - firstPending];
      if (interval !== undefined && this.lastSmoothed !== null) {
        interval.meters = ellipsoidDistance(this.lastSmoothed.latitude, this.lastSmoothed.longitude, latitude, longitude);
        interval.smoothed = true;
      }
      this.lastSmoothed = { latitude, longitude };
    }
    this.nextSmoothedStep = target + 1;
    trace.discardBefore(this.nextSmoothedStep);
  }

  private advanceLaps(t: number, events: LiveEvent[]): void {
    const point: LapPoint = { t, ...this.totals() };
    const trigger = this.lapper.trigger;
    if (trigger !== null) {
      for (const fraction of this.lapper.advance(this.lastPoint, point)) {
        this.closeLap({ t: this.lastPoint.t + (t - this.lastPoint.t) * fraction, distance: this.lastPoint.distance + (point.distance - this.lastPoint.distance) * fraction, moving: this.lastPoint.moving + (point.moving - this.lastPoint.moving) * fraction });
        events.push({ type: "lap", trigger, t: this.lapStart.t });
      }
    }
    this.lastPoint = point;
  }

  private closeLap(at: LapPoint): void {
    const start = this.lapStart;
    this.completed = [
      ...this.completed,
      { index: this.lapIndex, startMs: start.t, elapsedMs: Math.max(at.t - start.t, 0), movingMs: Math.round(at.moving - start.moving), distanceMm: Math.round((at.distance - start.distance) * 1000) },
    ];
    this.lapIndex += 1;
    this.lapStart = at;
  }

  private liveAltitude(settled: SettledFix): number | null {
    if (this.pipeline.hasBarometer) return settled.fusedAltitude;
    return settled.gnssAltitude === null ? null : this.gnssAltitude.push(settled.fix.t, settled.gnssAltitude, verticalSigma(settled.fix));
  }

  private kindOf(interval: PendingInterval): MotionIntervalKind {
    return intervalKind({ durationMs: interval.endMs - interval.startMs, meters: interval.meters, restart: interval.restart, paused: interval.paused, moving: interval.state === "moving" }, this.profile);
  }

  /** Commits the intervals that start at or before `until`: no later switch can backdate them. */
  private commit(until: number): void {
    let count = 0;
    for (const interval of this.pending) {
      if (interval.startMs > until || !interval.smoothed) break;
      count += 1;
      const counted = isCounted(this.kindOf(interval));
      const durationMs = interval.endMs - interval.startMs;
      if (counted) {
        this.distance += interval.meters;
        this.moving += durationMs;
        this.heartRate.integrate(interval.startMs, interval.endMs);
      }
      this.heartRate.prune(interval.endMs);
      if (interval.altitude !== null) {
        this.hysteresis ??= new ElevationHysteresis(this.pipeline.hasBarometer ? elevationThresholdMeters.barometer : elevationThresholdMeters.gnss);
        const ascentBefore = this.hysteresis.ascent;
        this.hysteresis.push(interval.altitude, counted);
        if (counted) this.grade = this.gradeMeter.push(this.distance, interval.altitude);
        this.vam.push(durationMs, this.hysteresis.ascent - ascentBefore, this.grade ?? Number.NaN, counted);
      }
      if (counted && this.profile.gradeAdjustedPace) this.gradeAdjustedDistance += interval.meters * gradeAdjustmentFactor(this.grade ?? Number.NaN);
    }
    if (count > 0) this.pending = this.pending.slice(count);
  }

  private totals(): Totals {
    let distance = this.distance;
    let moving = this.moving;
    for (const interval of this.pending) {
      if (!isCounted(this.kindOf(interval))) continue;
      distance += interval.meters;
      moving += interval.endMs - interval.startMs;
    }
    return { distance, moving };
  }

  private display(settled: SettledFix, kind: MotionIntervalKind): void {
    this.dashedSinceDisplay ||= kind === "paused" || kind === "gap";
    const { latitude, longitude } = settled.estimate;
    const last = this.displayed;
    if (last !== null && !this.dashedSinceDisplay && ellipsoidDistance(last.latitude, last.longitude, latitude, longitude) < displayStepMeters) return;
    const point: LivePoint = { t: settled.estimate.t, latitude, longitude, dashed: this.dashedSinceDisplay };
    this.displayed = point;
    this.dashedSinceDisplay = false;
    this.track.push(point);
  }

  private metrics(now: number, totals: Totals, lap: LiveLap, accuracy: number | null): LiveMetrics {
    const profile = this.profile;
    const pace = (movingMs: number, meters: number): number | null => (meters > 0 ? movingMs / 1000 / (meters / profile.pacePerMeters) : null);
    const paceNow = (speed: number): number | null => (speed > 0 && 1000 / speed <= slowestPaceSecondsPerKm ? Math.round(profile.pacePerMeters / speed) : null);
    const moving = this.classifier.state === "moving";
    const gradeFactor = gradeAdjustmentFactor(this.grade ?? Number.NaN);
    const reading = this.latestReading !== null && now - this.latestReading.t <= heartRateHoldMs ? this.latestReading.bpm : null;
    const values: Record<MetricKey, number | null> = {
      elapsed: Math.max(now - this.startMs, 0),
      moving: totals.moving,
      distance: totals.distance,
      pace_avg: pace(totals.moving, totals.distance),
      pace_now: moving ? paceNow(this.speedNow) : null,
      pace_lap: pace(lap.movingMs, lap.distanceMm / 1000),
      gap_avg: profile.gradeAdjustedPace ? pace(this.moving, this.gradeAdjustedDistance) : null,
      gap_now: profile.gradeAdjustedPace && moving ? paceNow(this.speedNow * gradeFactor) : null,
      speed_avg: totals.moving > 0 ? (totals.distance * 1000) / totals.moving : null,
      speed_now: this.speedNow,
      speed_max: this.speedMax,
      ascent: this.hysteresis?.ascent ?? null,
      descent: this.hysteresis?.descent ?? null,
      altitude: this.altitude,
      altitude_min: this.altitude === null ? null : this.altitudeMin,
      altitude_max: this.altitude === null ? null : this.altitudeMax,
      grade_now: moving ? this.grade : null,
      vam: this.vam.value,
      vertical_speed: this.verticalSpeedNow,
      cadence: this.previous?.cadence ?? null,
      steps: this.firstStepCount === null || this.lastStepCount === null ? null : this.lastStepCount - this.firstStepCount,
      heart_rate: reading,
      heart_rate_avg: this.heartRate.coveredMs > 0 ? (this.heartRate.beats * 60_000) / this.heartRate.coveredMs : null,
      heart_rate_max: this.heartRateMax,
      heart_rate_zone: null,
      energy: null,
      gps_quality: accuracy,
      clock: null,
    };
    const metrics: Partial<Record<MetricKey, number>> = {};
    for (const key of profile.metrics) {
      const value = values[key];
      if (value !== null) metrics[key] = value;
    }
    return metrics;
  }
}
