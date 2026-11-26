import type { MotionThresholds } from "@obnixe/schema";
import type { StepSample } from "../types.ts";

/** Above this horizontal accuracy in meters, the cadence decides instead of the GNSS speed when a pedometer reports (`GPS-034`). */
export const cadenceLeadAccuracy = 15;
export const cadenceWindowMs = 5000;
/** Window of the vertical speed fed to the classifier, shorter than the displayed one so stops on climbs are seen in time; barometric altitude only, GNSS altitude is too noisy at this scale. */
export const motionVerticalSpeedWindowMs = 10_000;

export type MotionState = "moving" | "stopped";

/** Measurements over the interval that ends at `t`, from the previous input. */
export interface MotionInput {
  readonly t: number;
  /** Filtered horizontal speed in m/s. */
  readonly speed: number;
  /** Smoothed vertical speed in m/s, `null` without a reliable altitude rate. */
  readonly verticalSpeed: number | null;
  /** Steps per minute, `null` without pedometer. */
  readonly cadence: number | null;
  /** Horizontal accuracy in meters of the latest fix. */
  readonly accuracy: number | null;
  /** A manual pause, always `stopped` (`GPS-033`). */
  readonly paused: boolean;
}

interface Thresholds {
  readonly startSpeed: number;
  readonly stopSpeed: number;
  readonly startVertical: number | null;
  readonly stopVertical: number | null;
  readonly startCadence: number | null;
  readonly stopCadence: number | null;
  readonly startAfterMs: number;
  readonly stopAfterMs: number;
}

/**
 * Stage 5: two-threshold hysteresis with two delays (`GPS-033`, `GPS-034`). A switch happens once the opposite condition has
 * held for its delay; `since` backdates it to the instant the condition began to hold.
 */
export class MotionClassifier {
  private readonly thresholds: Thresholds;
  private current: MotionState = "stopped";
  private currentSince: number | null = null;
  private heldSince: number | null = null;
  private lastT: number | null = null;

  constructor(motion: MotionThresholds) {
    const metersPerSecond = (value: number | null): number | null => (value === null ? null : value / 1000);
    this.thresholds = {
      startSpeed: motion.startSpeedMmS / 1000,
      stopSpeed: motion.stopSpeedMmS / 1000,
      startVertical: metersPerSecond(motion.startVerticalMmS),
      stopVertical: metersPerSecond(motion.stopVerticalMmS),
      startCadence: motion.startCadence,
      stopCadence: motion.stopCadence,
      startAfterMs: motion.startAfterMs,
      stopAfterMs: motion.stopAfterMs,
    };
  }

  get state(): MotionState {
    return this.current;
  }

  /** Start of the current state, `null` before the first input. */
  get since(): number | null {
    return this.currentSince;
  }

  /** Classifies the interval ending at `input.t`. */
  push(input: MotionInput): MotionState {
    const intervalStart = this.lastT ?? input.t;
    this.lastT = input.t;
    this.currentSince ??= intervalStart;
    if (input.paused) {
      if (this.current === "moving") this.switchTo("stopped", intervalStart);
      this.heldSince = null;
      return this.current;
    }
    const cadenceLeads = input.cadence !== null && this.thresholds.startCadence !== null && input.accuracy !== null && input.accuracy > cadenceLeadAccuracy;
    const opposite = this.current === "stopped" ? this.startHolds(input, cadenceLeads) : this.stopHolds(input, cadenceLeads);
    if (!opposite) {
      this.heldSince = null;
      return this.current;
    }
    this.heldSince ??= intervalStart;
    const delay = this.current === "stopped" ? this.thresholds.startAfterMs : this.thresholds.stopAfterMs;
    if (input.t - this.heldSince >= delay) this.switchTo(this.current === "stopped" ? "moving" : "stopped", this.heldSince);
    return this.current;
  }

  private switchTo(state: MotionState, since: number): void {
    this.current = state;
    this.currentSince = since;
    this.heldSince = null;
  }

  private startHolds(input: MotionInput, cadenceLeads: boolean): boolean {
    const { startSpeed, startVertical, startCadence } = this.thresholds;
    if (!cadenceLeads && input.speed >= startSpeed) return true;
    if (startVertical !== null && input.verticalSpeed !== null && Math.abs(input.verticalSpeed) >= startVertical) return true;
    return startCadence !== null && input.cadence !== null && input.cadence >= startCadence;
  }

  private stopHolds(input: MotionInput, cadenceLeads: boolean): boolean {
    const { stopSpeed, stopVertical, stopCadence } = this.thresholds;
    if (!cadenceLeads && input.speed >= stopSpeed) return false;
    if (stopVertical !== null && input.verticalSpeed !== null && Math.abs(input.verticalSpeed) >= stopVertical) return false;
    return stopCadence === null || input.cadence === null || input.cadence < stopCadence;
  }
}

/** Batch classification of each interval (1 = moving), every switch applied from the instant its condition began to hold. */
export function classifyIntervals(motion: MotionThresholds, inputs: readonly MotionInput[]): Uint8Array {
  const classifier = new MotionClassifier(motion);
  const states = new Uint8Array(inputs.length);
  let previous: MotionState = classifier.state;
  for (let index = 0; index < inputs.length; index += 1) {
    const input = inputs[index];
    if (input === undefined) continue;
    const state = classifier.push(input);
    const value = state === "moving" ? 1 : 0;
    states[index] = value;
    if (state === previous) continue;
    previous = state;
    const since = classifier.since ?? input.t;
    for (let back = index - 1; back > 0 && (inputs[back - 1]?.t ?? 0) >= since; back -= 1) states[back] = value;
  }
  return states;
}

/** Steps per minute over the trailing `cadenceWindowMs`, from cumulative step counts. */
export class CadenceMeter {
  private times: number[] = [];
  private counts: number[] = [];
  private head = 0;

  push(sample: StepSample): void {
    this.times.push(sample.t);
    this.counts.push(sample.count);
  }

  /** `null` before the first sample; queried times must not decrease. */
  at(t: number): number | null {
    const windowStart = t - cadenceWindowMs;
    while (this.head + 1 < this.times.length && (this.times[this.head + 1] ?? 0) <= windowStart) this.head += 1;
    if (this.head > 64 && this.head * 2 > this.times.length) {
      this.times = this.times.slice(this.head);
      this.counts = this.counts.slice(this.head);
      this.head = 0;
    }
    const last = this.times.length - 1;
    if (last < 0) return null;
    const baseTime = this.times[this.head] ?? 0;
    const span = baseTime <= windowStart ? cadenceWindowMs : t - baseTime;
    if (span <= 0) return 0;
    return (((this.counts[last] ?? 0) - (this.counts[this.head] ?? 0)) * 60_000) / span;
  }
}
