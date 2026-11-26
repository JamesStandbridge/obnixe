import type { HeartRateRange, PaceRange, RecordingAlert, RecordingAlertSettings } from "@obnixe/schema";
import type { LiveLap, LiveSnapshot } from "./live.ts";
import type { RecorderAlert, RecorderPhase } from "./recorder.ts";
import type { HeartRateZoneBounds } from "./zones.ts";

/** `REC-075`, `WKT-005`: out of a span after 8 s beyond its tolerance, back after 4 s inside it, repeated every 15 s at most 4 times. */
export const rangeAlertTiming = { outAfterMs: 8000, backAfterMs: 4000, repeatEveryMs: 15_000, maxAlerts: 4 } as const;
export const paceRangeTolerance = 0.02;
export const heartRateRangeToleranceBpm = 2;

/** `UX-005`: the slot target, the duration counting the moving time. */
export type AlertGoal = { readonly kind: "distance"; readonly meters: number } | { readonly kind: "duration"; readonly seconds: number };

export type RangeDeparture = "below" | "above";

export type RangeStatus = { readonly status: RangeDeparture; readonly repeat: number } | { readonly status: "back" };

export type SignalChange = "lost" | "back";

export type BatteryAlertLevel = "low" | "critical";

export type RecordingAlertEvent =
  | { readonly kind: "lap"; readonly lap: LiveLap }
  /** `index` counts from 1; `movingMs` is the moving time of that split alone (`GPS-060`). */
  | { readonly kind: "split"; readonly index: number; readonly meters: number; readonly movingMs: number }
  | { readonly kind: "auto_pause" }
  | { readonly kind: "auto_resume" }
  | { readonly kind: "goal"; readonly goal: AlertGoal }
  | ({ readonly kind: "pace_range"; readonly range: PaceRange } & RangeStatus)
  | ({ readonly kind: "heart_rate_range"; readonly range: HeartRateRange } & RangeStatus)
  | { readonly kind: "gps"; readonly change: SignalChange }
  | { readonly kind: "sensor"; readonly change: SignalChange }
  | { readonly kind: "battery"; readonly level: BatteryAlertLevel };

export type RecordingAlertKind = RecordingAlertEvent["kind"];

export interface AlertMonitorOptions {
  readonly splitMeters: number | null;
  readonly settings: RecordingAlertSettings;
  /** Null without a maximum heart rate: the heart-rate span is then not watched. */
  readonly heartRateZones: readonly HeartRateZoneBounds[] | null;
  readonly goal: AlertGoal | null;
}

/** The setting that switches an alert off; the spans are watched only when one is chosen. */
export function alertSettingOf(kind: RecordingAlertKind): RecordingAlert | null {
  switch (kind) {
    case "lap":
    case "split":
    case "goal":
    case "gps":
    case "sensor":
    case "battery":
      return kind;
    case "auto_pause":
    case "auto_resume":
      return "auto_pause";
    case "pace_range":
    case "heart_rate_range":
      return null;
    default: {
      const unreachable: never = kind;
      throw new Error(`Unhandled alert ${String(unreachable)}`);
    }
  }
}

type RangePosition = RangeDeparture | "inside" | "margin";

export interface SpanBounds {
  readonly low: number;
  readonly high: number;
}

function positionIn(value: number, bounds: SpanBounds, tolerance: SpanBounds): RangePosition {
  if (value < bounds.low - tolerance.low) return "below";
  if (value > bounds.high + tolerance.high) return "above";
  return value >= bounds.low && value <= bounds.high ? "inside" : "margin";
}

/** Hysteresis of one watched span: the margin between the span and its tolerance neither leaves nor comes back. */
class RangeWatch {
  private candidate: { readonly departure: RangeDeparture; readonly since: number } | null = null;
  private alerted: { readonly departure: RangeDeparture; firedAt: number; count: number } | null = null;
  private insideSince: number | null = null;

  update(t: number, position: RangePosition): RangeStatus | null {
    switch (position) {
      case "below":
      case "above":
        return this.outside(t, position);
      case "margin":
        this.candidate = null;
        this.insideSince = null;
        return null;
      case "inside": {
        this.candidate = null;
        this.insideSince ??= t;
        if (this.alerted === null || t - this.insideSince < rangeAlertTiming.backAfterMs) return null;
        this.alerted = null;
        return { status: "back" };
      }
      default: {
        const unreachable: never = position;
        throw new Error(`Unhandled range position ${String(unreachable)}`);
      }
    }
  }

  reset(): void {
    this.candidate = null;
    this.alerted = null;
    this.insideSince = null;
  }

  private outside(t: number, departure: RangeDeparture): RangeStatus | null {
    this.insideSince = null;
    if (this.candidate?.departure !== departure) this.candidate = { departure, since: t };
    const alerted = this.alerted;
    if (alerted?.departure === departure) {
      if (alerted.count >= rangeAlertTiming.maxAlerts || t - alerted.firedAt < rangeAlertTiming.repeatEveryMs) return null;
      alerted.firedAt = t;
      alerted.count += 1;
      return { status: departure, repeat: alerted.count - 1 };
    }
    if (t - this.candidate.since < rangeAlertTiming.outAfterMs) return null;
    this.alerted = { departure, firedAt: t, count: 1 };
    return { status: departure, repeat: 0 };
  }
}

interface Progress {
  readonly meters: number;
  readonly movingMs: number;
}

/**
 * `REC-075`: turns the live snapshots, recorder alerts, sensor and battery changes of one recording into the alerts to signal,
 * already filtered by the sport's settings. The first snapshot only sets the baselines, so a monitor created after a reload
 * does not announce the splits or the goal already passed.
 */
export class AlertMonitor {
  private readonly options: AlertMonitorOptions;
  private readonly pace = new RangeWatch();
  private readonly heartRate = new RangeWatch();
  private previous: Progress | null = null;
  private splitIndex = 0;
  private splitMovingMs = 0;
  private goalReached = false;
  private hadFix = false;
  private gpsLost = false;
  private sensorLost = false;
  private readonly batteryAlerted = new Set<BatteryAlertLevel>();

  constructor(options: AlertMonitorOptions) {
    this.options = options;
  }

  /** The recorder's own alerts; `lap` is the lap just finished. */
  recorder(alert: RecorderAlert, lap: LiveLap | null): readonly RecordingAlertEvent[] {
    switch (alert) {
      case "lap":
        return lap === null ? [] : this.emit([{ kind: "lap", lap }]);
      case "auto_pause":
        return this.emit([{ kind: "auto_pause" }]);
      case "auto_resume":
        return this.emit([{ kind: "auto_resume" }]);
      default: {
        const unreachable: never = alert;
        throw new Error(`Unhandled recorder alert ${String(unreachable)}`);
      }
    }
  }

  /** Called with each new snapshot, at least once per journal batch. */
  observe(snapshot: LiveSnapshot, phase: RecorderPhase): readonly RecordingAlertEvent[] {
    const events: RecordingAlertEvent[] = [];
    const progress: Progress = { meters: snapshot.distanceMm / 1000, movingMs: snapshot.movingMs };
    this.progress(progress, events);
    this.signal(snapshot, phase, events);
    this.ranges(snapshot, phase, events);
    this.previous = progress;
    return this.emit(events);
  }

  /** `heart_rate_lost` from the tracker, then the first reading after it. */
  heartRateSource(connected: boolean): readonly RecordingAlertEvent[] {
    if (connected === !this.sensorLost) return [];
    this.sensorLost = !connected;
    return this.emit([{ kind: "sensor", change: connected ? "back" : "lost" }]);
  }

  battery(level: BatteryAlertLevel): readonly RecordingAlertEvent[] {
    if (this.batteryAlerted.has(level)) return [];
    this.batteryAlerted.add(level);
    return this.emit([{ kind: "battery", level }]);
  }

  private progress(current: Progress, events: RecordingAlertEvent[]): void {
    const previous = this.previous;
    const split = this.options.splitMeters;
    const goal = this.options.goal;
    if (previous === null) {
      if (split !== null) this.splitIndex = Math.floor(current.meters / split);
      this.splitMovingMs = current.movingMs;
      this.goalReached = goal !== null && reached(goal, current);
      return;
    }
    if (split !== null) {
      while ((this.splitIndex + 1) * split <= current.meters) {
        this.splitIndex += 1;
        const at = this.splitIndex * split;
        const fraction = current.meters > previous.meters ? Math.min(1, Math.max(0, (at - previous.meters) / (current.meters - previous.meters))) : 1;
        const movingAt = previous.movingMs + (current.movingMs - previous.movingMs) * fraction;
        events.push({ kind: "split", index: this.splitIndex, meters: split, movingMs: Math.round(movingAt - this.splitMovingMs) });
        this.splitMovingMs = movingAt;
      }
    }
    if (goal !== null && !this.goalReached && reached(goal, current)) {
      this.goalReached = true;
      events.push({ kind: "goal", goal });
    }
  }

  private signal(snapshot: LiveSnapshot, phase: RecorderPhase, events: RecordingAlertEvent[]): void {
    if (snapshot.signal.level !== "none") {
      this.hadFix = true;
      if (this.gpsLost) events.push({ kind: "gps", change: "back" });
      this.gpsLost = false;
      return;
    }
    if (this.hadFix && !this.gpsLost && (phase === "recording" || phase === "auto_paused")) {
      this.gpsLost = true;
      events.push({ kind: "gps", change: "lost" });
    }
  }

  private ranges(snapshot: LiveSnapshot, phase: RecorderPhase, events: RecordingAlertEvent[]): void {
    const { paceRange, heartRateRange } = this.options.settings;
    const speed = snapshot.speed;
    if (paceRange === null || phase !== "recording" || snapshot.motion !== "moving") {
      this.pace.reset();
    } else {
      const bounds = speedBounds(paceRange);
      const status = this.pace.update(snapshot.t, positionIn(speed, bounds, { low: bounds.low * paceRangeTolerance, high: bounds.high * paceRangeTolerance }));
      if (status !== null) events.push({ kind: "pace_range", range: paceRange, ...status });
    }
    const bpm = snapshot.heartRate;
    const zones = this.options.heartRateZones;
    if (heartRateRange === null || zones === null || phase !== "recording" || bpm === null) {
      this.heartRate.reset();
    } else {
      const bounds = heartRateBounds(heartRateRange, zones);
      const status = this.heartRate.update(snapshot.t, positionIn(bpm, bounds, { low: heartRateRangeToleranceBpm, high: heartRateRangeToleranceBpm }));
      if (status !== null) events.push({ kind: "heart_rate_range", range: heartRateRange, ...status });
    }
  }

  private emit(events: readonly RecordingAlertEvent[]): readonly RecordingAlertEvent[] {
    const disabled = this.options.settings.disabled;
    return events.filter((event) => {
      const setting = alertSettingOf(event.kind);
      return setting === null || !disabled.includes(setting);
    });
  }
}

function reached(goal: AlertGoal, progress: Progress): boolean {
  switch (goal.kind) {
    case "distance":
      return progress.meters >= goal.meters;
    case "duration":
      return progress.movingMs >= goal.seconds * 1000;
    default: {
      const unreachable: never = goal;
      throw new Error(`Unhandled goal ${JSON.stringify(unreachable)}`);
    }
  }
}

/** The span as speeds in m/s: the slowest pace is the lowest speed. */
export function speedBounds(range: PaceRange): SpanBounds {
  switch (range.kind) {
    case "pace":
      return { low: 1000 / range.slowestSecondsPerKm, high: 1000 / range.fastestSecondsPerKm };
    case "speed":
      return { low: range.minMmS / 1000, high: range.maxMmS / 1000 };
    default: {
      const unreachable: never = range;
      throw new Error(`Unhandled pace range ${JSON.stringify(unreachable)}`);
    }
  }
}

/** From the lowest bpm of the lowest zone to the highest bpm of the highest one, zone 5 being open above. */
export function heartRateBounds(range: HeartRateRange, zones: readonly HeartRateZoneBounds[]): SpanBounds {
  const lowest = zones.find((bounds) => bounds.zone === range.lowest);
  const highest = zones.find((bounds) => bounds.zone === range.highest);
  return { low: lowest?.minBpm ?? 0, high: range.highest === 5 ? Number.POSITIVE_INFINITY : (highest?.maxBpm ?? Number.POSITIVE_INFINITY) };
}
