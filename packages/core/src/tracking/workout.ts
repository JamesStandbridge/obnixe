import type { Lap, WorkoutDuration, WorkoutIntent, WorkoutPlan, WorkoutStep, WorkoutTarget } from "@obnixe/schema";
import { heartRateBounds, heartRateRangeToleranceBpm, paceRangeTolerance, positionIn, RangeWatch, speedBounds } from "./alerts.ts";
import type { RangePosition, RecordingAlertEvent, SpanBounds } from "./alerts.ts";
import { activityWindow } from "./batch.ts";
import type { LapSource } from "./batch.ts";
import type { Track } from "./codec/track.ts";
import { trackFeed } from "./feed.ts";
import { LiveTracker } from "./live.ts";
import type { TrackerProgress } from "./live.ts";
import type { ResolvedProfile } from "./profile.ts";
import type { AutoLap, LapBounds } from "./stages/derive.ts";
import type { TrackerMark } from "./types.ts";
import type { HeartRateZoneBounds, TimeSpan } from "./zones.ts";

/** `WKT-005`: pace and speed smoothed over 10 s of chronometer time, heart rate averaged over 5 s, 20 s to settle into a work step. */
export const workoutTargetTiming = { speedWindowMs: 10_000, heartRateWindowMs: 5000, workGraceMs: 20_000 } as const;

export interface WorkoutRepetition {
  /** From 1 to `count`. */
  readonly number: number;
  readonly count: number;
}

/** A step of the unfolded plan; `index` is its rank, stored as `lap.workout_step` (`WKT-007`). */
export interface WorkoutStepRun {
  readonly index: number;
  readonly intent: WorkoutIntent;
  readonly duration: WorkoutDuration;
  readonly target: WorkoutTarget;
  readonly label: string | null;
  /** Null for a step outside a repeat. */
  readonly repetition: WorkoutRepetition | null;
}

function runOf(step: WorkoutStep, index: number, repetition: WorkoutRepetition | null): WorkoutStepRun {
  return { index, intent: step.intent, duration: step.duration, target: step.target, label: step.label, repetition };
}

/** The steps of the plan in the order they are run, each repeat written out `count` times. */
export function unfoldWorkout(plan: WorkoutPlan): readonly WorkoutStepRun[] {
  const steps: WorkoutStepRun[] = [];
  for (const node of plan.nodes) {
    switch (node.type) {
      case "step":
        steps.push(runOf(node, steps.length, null));
        break;
      case "repeat":
        for (let number = 1; number <= node.count; number += 1) for (const step of node.steps) steps.push(runOf(step, steps.length, { number, count: node.count }));
        break;
      default: {
        const unreachable: never = node;
        throw new Error(`Unhandled workout node ${JSON.stringify(unreachable)}`);
      }
    }
  }
  return steps;
}

/** A finished step, on the time base of the samples. */
export interface WorkoutStepSpan {
  readonly index: number;
  readonly startMs: number;
  readonly endMs: number;
}

export type WorkoutRemaining = { readonly kind: "time"; readonly ms: number } | { readonly kind: "distance"; readonly mm: number } | { readonly kind: "open" };

/** The current step's target against the smoothed value: speeds in m/s, heart rates in bpm. */
export interface WorkoutTargetReading {
  /** Null for a heart-rate zone without a maximum heart rate. */
  readonly bounds: SpanBounds | null;
  readonly value: number | null;
  readonly position: RangePosition | null;
}

/** What the guided live screen shows (`WKT-004`). */
export interface WorkoutView {
  readonly steps: readonly WorkoutStepRun[];
  readonly started: boolean;
  /** The step being run, the first one before the start, null once the plan is done. */
  readonly current: WorkoutStepRun | null;
  readonly next: WorkoutStepRun | null;
  /** Chronometer time in the current step, manual pauses excluded. */
  readonly stepElapsedMs: number;
  readonly stepDistanceMm: number;
  readonly remaining: WorkoutRemaining | null;
  /** Null when the step has no target. */
  readonly target: WorkoutTargetReading | null;
  readonly done: readonly WorkoutStepSpan[];
}

/** Chronometer time a step's target was judged, and inside its strict span (`WKT-007`). */
export interface WorkoutTargetTally {
  readonly judgedMs: number;
  readonly insideMs: number;
}

export interface WorkoutRunnerOptions {
  /** Null without a maximum heart rate: heart-rate zone targets are then not watched. */
  readonly heartRateZones: readonly HeartRateZoneBounds[] | null;
}

interface Odometer {
  readonly timerMs: number;
  readonly distanceMm: number;
}

interface HeartReading {
  readonly t: number;
  readonly bpm: number;
}

function distanceBetween(from: TrackerProgress | null, to: TrackerProgress, t: number): number {
  if (from === null || t <= from.t) return (from ?? to).distanceMm;
  if (t >= to.t || to.t <= from.t) return to.distanceMm;
  return from.distanceMm + ((to.distanceMm - from.distanceMm) * (t - from.t)) / (to.t - from.t);
}

/**
 * `WKT-003`: runs the unfolded plan on the tracker progress after each fix and on the journal marks, with no clock of its own;
 * `advance` only closes time steps between fixes so their end is signalled on time (`WKT-006`). Time steps count chronometer
 * time (elapsed minus manual pauses, auto-pause ignored), distance steps the counted distance with the crossing interpolated
 * between fixes, open steps end with a lap mark. A lap mark once the plan is done is a manual lap.
 */
export class WorkoutRunner {
  readonly steps: readonly WorkoutStepRun[];
  private readonly zones: readonly HeartRateZoneBounds[] | null;
  private readonly watch = new RangeWatch();
  private readonly spans: WorkoutStepSpan[] = [];
  private readonly manualLaps: number[] = [];
  private origin: number | null = null;
  private pausedMs = 0;
  private pausedSince: number | null = null;
  private index = 0;
  private stepStartMs = 0;
  private stepStartTimerMs = 0;
  /** Null until a fix at or after the step start lets it be interpolated. */
  private stepStartDistanceMm: number | null = null;
  private earlier: TrackerProgress | null = null;
  private latest: TrackerProgress | null = null;
  private odometer: Odometer[] = [];
  private heart: HeartReading[] = [];
  private reading: WorkoutTargetReading | null = null;
  private readonly tallies: { judgedMs: number; insideMs: number }[];
  private judgedAt: { readonly t: number; readonly inside: boolean } | null = null;

  constructor(plan: WorkoutPlan, options: WorkoutRunnerOptions) {
    this.steps = unfoldWorkout(plan);
    this.zones = options.heartRateZones;
    this.tallies = this.steps.map(() => ({ judgedMs: 0, insideMs: 0 }));
  }

  get started(): boolean {
    return this.origin !== null;
  }

  /** The judged time of each step's target, by rank. */
  get targetTallies(): readonly WorkoutTargetTally[] {
    return this.tallies;
  }

  /** Every step is done. */
  get finished(): boolean {
    return this.origin !== null && this.index >= this.steps.length;
  }

  /** Takes a journal mark after the tracker did. */
  mark(mark: TrackerMark): readonly RecordingAlertEvent[] {
    if (this.origin === null) {
      if (mark.kind !== "start") return [];
      this.origin = mark.t;
      this.stepStartMs = mark.t;
      this.stepStartDistanceMm = this.distanceAt(mark.t);
      return [{ kind: "workout_step", step: this.steps[0] ?? null }];
    }
    const events = [...this.closeTimeSteps(mark.t)];
    switch (mark.kind) {
      case "start":
      case "resume":
        if (this.pausedSince !== null && mark.t > this.pausedSince) this.pausedMs += mark.t - this.pausedSince;
        this.pausedSince = null;
        break;
      case "pause":
      case "stop":
        this.pausedSince ??= mark.t;
        this.watch.reset();
        this.judgedAt = null;
        break;
      case "lap":
        if (this.finished) this.manualLaps.push(mark.t);
        else events.push(...this.endStep(mark.t, this.timerAt(mark.t), this.distanceAt(mark.t)));
        break;
      default: {
        const unreachable: never = mark.kind;
        throw new Error(`Unhandled mark ${String(unreachable)}`);
      }
    }
    return events;
  }

  /** Takes the tracker progress after each fix. */
  push(progress: TrackerProgress): readonly RecordingAlertEvent[] {
    if (this.stepStartDistanceMm === null && this.stepStartMs <= progress.t) this.stepStartDistanceMm = distanceBetween(this.latest, progress, this.stepStartMs);
    this.earlier = this.latest;
    this.latest = progress;
    if (this.origin === null) return [];
    const events = [...this.closeTimeSteps(progress.t)];
    for (;;) {
      const step = this.steps[this.index];
      const baseline = this.stepStartDistanceMm;
      if (step?.duration.kind !== "distance" || baseline === null) break;
      const goal = baseline + step.duration.mm;
      if (progress.distanceMm < goal) break;
      const from = this.earlier !== null && this.earlier.t > this.stepStartMs ? this.earlier : { t: this.stepStartMs, distanceMm: baseline };
      const gained = progress.distanceMm - from.distanceMm;
      const fraction = gained > 0 ? Math.min(1, Math.max(0, (goal - from.distanceMm) / gained)) : 1;
      const endMs = from.t + (progress.t - from.t) * fraction;
      events.push(...this.endStep(endMs, this.timerAt(endMs), goal), ...this.closeTimeSteps(progress.t));
    }
    this.record(progress);
    events.push(...this.evaluate(progress.t));
    return events;
  }

  /** Between fixes: ends the time steps elapsed at `now`. */
  advance(now: number): readonly RecordingAlertEvent[] {
    return this.origin === null ? [] : this.closeTimeSteps(now);
  }

  view(now: number): WorkoutView {
    const current = this.steps[this.index] ?? null;
    const stepElapsedMs = this.origin === null || current === null ? 0 : Math.max(0, this.timerAt(now) - this.stepStartTimerMs);
    const baseline = this.stepStartDistanceMm;
    const stepDistanceMm = this.origin === null || current === null || baseline === null || this.latest === null ? 0 : Math.max(0, Math.round(this.latest.distanceMm - baseline));
    return {
      steps: this.steps,
      started: this.origin !== null,
      current,
      next: this.steps[this.index + 1] ?? null,
      stepElapsedMs,
      stepDistanceMm,
      remaining: current === null ? null : remainingOf(current.duration, stepElapsedMs, stepDistanceMm),
      target: current === null || current.target.kind === "none" ? null : (this.reading ?? { bounds: this.boundsOf(current.target), value: null, position: null }),
      done: this.spans,
    };
  }

  /**
   * The laps of the guided activity as offsets from the start of `window` (`WKT-007`): one `workout` lap per step run, the
   * unfinished one up to the end; once the plan is done, the remaining time split at the manual laps.
   */
  lapBounds(window: TimeSpan): readonly LapBounds[] {
    const ends: { readonly trigger: Lap["trigger"]; readonly workoutStep: number | null; readonly endMs: number }[] = this.spans.map((span) => ({ trigger: "workout", workoutStep: span.index, endMs: span.endMs }));
    if (this.index < this.steps.length) {
      ends.push({ trigger: "workout", workoutStep: this.index, endMs: window.endMs });
    } else {
      for (const t of this.manualLaps) ends.push({ trigger: "manual", workoutStep: null, endMs: t });
      ends.push({ trigger: "manual", workoutStep: null, endMs: window.endMs });
    }
    const elapsedMs = window.endMs - window.startMs;
    const laps: LapBounds[] = [];
    let startOffsetMs = 0;
    for (const end of ends) {
      const endOffsetMs = Math.min(Math.round(end.endMs - window.startMs), elapsedMs);
      if (endOffsetMs <= startOffsetMs) continue;
      laps.push({ trigger: end.trigger, startOffsetMs, endOffsetMs, workoutStep: end.workoutStep });
      startOffsetMs = endOffsetMs;
    }
    return laps;
  }

  private timerAt(t: number): number {
    if (this.origin === null) return 0;
    return t - this.origin - this.pausedMs - (this.pausedSince === null ? 0 : Math.max(0, t - this.pausedSince));
  }

  /** The counted distance at `t`, interpolated between the last two fixes; null after the last one. */
  private distanceAt(t: number): number | null {
    const latest = this.latest;
    if (latest === null || t > latest.t) return null;
    return distanceBetween(this.earlier, latest, t);
  }

  private closeTimeSteps(now: number): readonly RecordingAlertEvent[] {
    const events: RecordingAlertEvent[] = [];
    for (;;) {
      const step = this.steps[this.index];
      if (step?.duration.kind !== "time" || this.pausedSince !== null) break;
      const endTimerMs = this.stepStartTimerMs + step.duration.ms;
      const overMs = this.timerAt(now) - endTimerMs;
      if (overMs < 0) break;
      const endMs = now - overMs;
      events.push(...this.endStep(endMs, endTimerMs, this.distanceAt(endMs)));
    }
    return events;
  }

  private endStep(endMs: number, timerMs: number, distanceMm: number | null): readonly RecordingAlertEvent[] {
    this.spans.push({ index: this.index, startMs: this.stepStartMs, endMs });
    this.index += 1;
    this.stepStartMs = endMs;
    this.stepStartTimerMs = timerMs;
    this.stepStartDistanceMm = distanceMm;
    this.watch.reset();
    this.reading = null;
    this.judgedAt = null;
    return [{ kind: "workout_step", step: this.steps[this.index] ?? null }];
  }

  private record(progress: TrackerProgress): void {
    const timerMs = this.timerAt(progress.t);
    this.odometer.push({ timerMs, distanceMm: progress.distanceMm });
    let first = 0;
    while (first + 1 < this.odometer.length && (this.odometer[first + 1]?.timerMs ?? 0) <= timerMs - workoutTargetTiming.speedWindowMs) first += 1;
    if (first > 0) this.odometer = this.odometer.slice(first);
    if (progress.heartRate !== null) this.heart.push({ t: progress.t, bpm: progress.heartRate });
    this.heart = this.heart.filter((reading) => reading.t > progress.t - workoutTargetTiming.heartRateWindowMs);
  }

  private evaluate(t: number): readonly RecordingAlertEvent[] {
    const step = this.steps[this.index];
    if (step === undefined || step.target.kind === "none" || this.pausedSince !== null) {
      this.reading = null;
      this.watch.reset();
      this.judgedAt = null;
      return [];
    }
    const bounds = this.boundsOf(step.target);
    const value = this.valueOf(step.target);
    const position = bounds === null || value === null ? null : positionIn(value, bounds, this.toleranceOf(step.target, bounds));
    this.reading = { bounds, value, position };
    this.tally(step.index, t, position);
    const settling = step.intent === "work" && this.timerAt(t) - this.stepStartTimerMs < workoutTargetTiming.workGraceMs;
    if (position === null || settling) {
      this.watch.reset();
      return [];
    }
    const status = this.watch.update(t, position);
    return status === null ? [] : [{ kind: "workout_target", step, ...status }];
  }

  /** Each stretch between two judgements counts as the earlier one found it. */
  private tally(index: number, t: number, position: RangePosition | null): void {
    const tally = this.tallies[index];
    if (tally !== undefined && this.judgedAt !== null && t > this.judgedAt.t) {
      tally.judgedMs += t - this.judgedAt.t;
      if (this.judgedAt.inside) tally.insideMs += t - this.judgedAt.t;
    }
    this.judgedAt = position === null ? null : { t, inside: position === "inside" };
  }

  private boundsOf(target: Exclude<WorkoutTarget, { readonly kind: "none" }>): SpanBounds | null {
    switch (target.kind) {
      case "pace":
      case "speed":
        return speedBounds(target);
      case "heart_rate":
        return { low: target.minBpm, high: target.maxBpm };
      case "heart_rate_zone":
        return this.zones === null ? null : heartRateBounds({ lowest: target.zone, highest: target.zone }, this.zones);
      default: {
        const unreachable: never = target;
        throw new Error(`Unhandled workout target ${JSON.stringify(unreachable)}`);
      }
    }
  }

  private valueOf(target: Exclude<WorkoutTarget, { readonly kind: "none" }>): number | null {
    switch (target.kind) {
      case "pace":
      case "speed": {
        const first = this.odometer[0];
        const last = this.odometer.at(-1);
        if (first === undefined || last === undefined || last.timerMs - first.timerMs < workoutTargetTiming.speedWindowMs / 2) return null;
        return (last.distanceMm - first.distanceMm) / (last.timerMs - first.timerMs);
      }
      case "heart_rate":
      case "heart_rate_zone":
        return this.heart.length === 0 ? null : this.heart.reduce((sum, reading) => sum + reading.bpm, 0) / this.heart.length;
      default: {
        const unreachable: never = target;
        throw new Error(`Unhandled workout target ${JSON.stringify(unreachable)}`);
      }
    }
  }

  private toleranceOf(target: Exclude<WorkoutTarget, { readonly kind: "none" }>, bounds: SpanBounds): SpanBounds {
    switch (target.kind) {
      case "pace":
      case "speed":
        return { low: bounds.low * paceRangeTolerance, high: bounds.high * paceRangeTolerance };
      case "heart_rate":
      case "heart_rate_zone":
        return { low: heartRateRangeToleranceBpm, high: heartRateRangeToleranceBpm };
      default: {
        const unreachable: never = target;
        throw new Error(`Unhandled workout target ${JSON.stringify(unreachable)}`);
      }
    }
  }
}

function remainingOf(duration: WorkoutDuration, elapsedMs: number, distanceMm: number): WorkoutRemaining {
  switch (duration.kind) {
    case "time":
      return { kind: "time", ms: Math.max(0, duration.ms - elapsedMs) };
    case "distance":
      return { kind: "distance", mm: Math.max(0, duration.mm - distanceMm) };
    case "open":
      return { kind: "open" };
    default: {
      const unreachable: never = duration;
      throw new Error(`Unhandled workout duration ${JSON.stringify(unreachable)}`);
    }
  }
}

/**
 * The step laps of a guided recording replayed from its track (`WKT-003`): the live tracker and the runner fed in the
 * canonical order of `trackFeed`, so the stored bounds are exactly those a later replay finds.
 */
export function workoutLapBounds(track: Track, profile: ResolvedProfile, plan: WorkoutPlan): readonly LapBounds[] {
  return replayWorkout(track, profile, plan, { heartRateZones: null }).lapBounds(activityWindow(track.samples, track.marks, { startMs: 0, endMs: null }));
}

/** The judged time of each step's target over the whole track (`WKT-007`), by rank. */
export function workoutTargetTallies(track: Track, profile: ResolvedProfile, plan: WorkoutPlan, options: WorkoutRunnerOptions): readonly WorkoutTargetTally[] {
  return replayWorkout(track, profile, plan, options).targetTallies;
}

function replayWorkout(track: Track, profile: ResolvedProfile, plan: WorkoutPlan, options: WorkoutRunnerOptions): WorkoutRunner {
  const tracker = new LiveTracker(profile, null);
  const runner = new WorkoutRunner(plan, options);
  for (const item of trackFeed(track)) {
    switch (item.kind) {
      case "mark":
        tracker.mark(item.mark);
        runner.mark(item.mark);
        break;
      case "sample":
        tracker.push(item.sample);
        if (item.sample.type === "fix") runner.push(tracker.progress(item.sample.t));
        break;
      default: {
        const unreachable: never = item;
        throw new Error(`Unhandled feed item ${JSON.stringify(unreachable)}`);
      }
    }
  }
  return runner;
}

/** The laps a recording saves: the steps of its guided workout (`WKT-007`), else its manual and automatic laps. */
export function recordingLapSource(track: Track, profile: ResolvedProfile, autoLap: AutoLap, workout: WorkoutPlan | null): LapSource {
  return workout === null ? { kind: "recorded", autoLap } : { kind: "given", laps: workoutLapBounds(track, profile, workout) };
}
