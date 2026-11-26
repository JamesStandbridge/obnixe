import { describe, expect, it } from "vitest";
import type { Id, RecordingAlertSettings } from "@obnixe/schema";
import { AlertMonitor, heartRateBounds, rangeAlertTiming, speedBounds } from "./alerts.ts";
import type { AlertMonitorOptions, RecordingAlertEvent } from "./alerts.ts";
import type { LiveLap, LiveSnapshot } from "./live.ts";
import type { RecorderPhase } from "./recorder.ts";
import { heartRateZones } from "./zones.ts";

const noAlerts: RecordingAlertSettings = { disabled: [], sound: false, paceRange: null, heartRateRange: null };

const lap: LiveLap = { index: 0, startMs: 0, elapsedMs: 300_000, movingMs: 300_000, distanceMm: 1_000_000 };

function snapshot(t: number, fields: Partial<LiveSnapshot> = {}): LiveSnapshot {
  return {
    t,
    motion: "moving",
    elapsedMs: t,
    movingMs: t,
    distanceMm: 0,
    lap,
    metrics: {},
    signal: { level: "good", accuracy: 4 },
    position: null,
    speed: 3,
    heartRate: null,
    ...fields,
  };
}

function monitor(options: Partial<AlertMonitorOptions> = {}): AlertMonitor {
  return new AlertMonitor({ splitMeters: 1000, settings: noAlerts, heartRateZones: null, goal: null, ...options });
}

/** Feeds one snapshot a second from `from` to `to` included and returns every alert. */
function feed(target: AlertMonitor, from: number, to: number, at: (t: number) => Partial<LiveSnapshot>, phase: RecorderPhase = "recording"): RecordingAlertEvent[] {
  const events: RecordingAlertEvent[] = [];
  for (let t = from; t <= to; t += 1000) events.push(...target.observe(snapshot(t, at(t)), phase));
  return events;
}

describe("splits and goal", () => {
  it("announces each split with the moving time interpolated at its bound (GPS-060)", () => {
    const target = monitor();
    const events = feed(target, 0, 700_000, (t) => ({ distanceMm: t * 3, movingMs: t }));
    const splits = events.filter((event) => event.kind === "split");
    expect(splits.map((event) => event.index)).toEqual([1, 2]);
    for (const split of splits) expect(split.movingMs).toBeCloseTo(333_333, -1);
  });

  it("does not announce what a monitor created mid-activity already passed", () => {
    const target = monitor({ goal: { kind: "distance", meters: 2000 } });
    const events = feed(target, 900_000, 1_000_000, (t) => ({ distanceMm: t * 3, movingMs: t }));
    expect(events.map((event) => (event.kind === "split" ? event.index : event.kind))).toEqual([3]);
  });

  it("signals the slot target once, the duration counting the moving time (UX-005)", () => {
    const target = monitor({ splitMeters: null, goal: { kind: "duration", seconds: 60 } });
    const events = feed(target, 0, 120_000, (t) => ({ movingMs: Math.max(0, t - 30_000) }));
    expect(events).toEqual([{ kind: "goal", goal: { kind: "duration", seconds: 60 } }]);
  });
});

describe("spans", () => {
  const pace: RecordingAlertSettings = { ...noAlerts, paceRange: { kind: "pace", fastestSecondsPerKm: 300, slowestSecondsPerKm: 360 } };

  it("converts pace spans to speeds and opens zone 5 above", () => {
    expect(speedBounds({ kind: "pace", fastestSecondsPerKm: 250, slowestSecondsPerKm: 400 })).toEqual({ low: 2.5, high: 4 });
    expect(speedBounds({ kind: "speed", minMmS: 5000, maxMmS: 8000 })).toEqual({ low: 5, high: 8 });
    const zones = heartRateZones(200);
    expect(heartRateBounds({ lowest: 2, highest: 3 }, zones)).toEqual({ low: 120, high: 160 });
    expect(heartRateBounds({ lowest: 4, highest: 5 }, zones)).toEqual({ low: 160, high: Number.POSITIVE_INFINITY });
  });

  it("leaves a pace span after 8 s beyond the tolerance, repeats every 15 s at most 4 times, and comes back after 4 s (WKT-005)", () => {
    const target = monitor({ splitMeters: null, settings: pace });
    const slow = 1000 / 380;
    const events = feed(target, 0, 120_000, (t) => ({ speed: t < 100_000 ? slow : 3 }));
    expect(events).toEqual([
      { kind: "pace_range", range: pace.paceRange, status: "below", repeat: 0 },
      { kind: "pace_range", range: pace.paceRange, status: "below", repeat: 1 },
      { kind: "pace_range", range: pace.paceRange, status: "below", repeat: 2 },
      { kind: "pace_range", range: pace.paceRange, status: "below", repeat: 3 },
      { kind: "pace_range", range: pace.paceRange, status: "back" },
    ]);
  });

  it("times the alerts from the first snapshot out of the span", () => {
    const target = monitor({ splitMeters: null, settings: pace });
    const fast = 1000 / 250;
    expect(feed(target, 0, rangeAlertTiming.outAfterMs - 1000, () => ({ speed: fast }))).toEqual([]);
    expect(feed(target, rangeAlertTiming.outAfterMs, rangeAlertTiming.outAfterMs, () => ({ speed: fast }))).toEqual([{ kind: "pace_range", range: pace.paceRange, status: "above", repeat: 0 }]);
  });

  it("ignores the tolerance margin, the stops and the pauses", () => {
    const margin = 1000 / 365;
    expect(feed(monitor({ splitMeters: null, settings: pace }), 0, 60_000, () => ({ speed: margin }))).toEqual([]);
    expect(feed(monitor({ splitMeters: null, settings: pace }), 0, 60_000, () => ({ speed: 1, motion: "stopped" }))).toEqual([]);
    expect(feed(monitor({ splitMeters: null, settings: pace }), 0, 60_000, () => ({ speed: 1 }), "auto_paused")).toEqual([]);
  });

  it("watches the heart-rate zones only with a maximum heart rate", () => {
    const settings: RecordingAlertSettings = { ...noAlerts, heartRateRange: { lowest: 2, highest: 2 } };
    expect(feed(monitor({ splitMeters: null, settings }), 0, 30_000, () => ({ heartRate: 175 }))).toEqual([]);
    const events = feed(monitor({ splitMeters: null, settings, heartRateZones: heartRateZones(200) }), 0, 30_000, (t) => ({ heartRate: t < 20_000 ? 145 : 130 }));
    expect(events).toEqual([
      { kind: "heart_rate_range", range: settings.heartRateRange, status: "above", repeat: 0 },
      { kind: "heart_rate_range", range: settings.heartRateRange, status: "back" },
    ]);
  });
});

describe("signal, sensor, battery and settings", () => {
  it("signals the GPS lost while active once a fix was seen, then back", () => {
    const target = monitor({ splitMeters: null });
    const none = { signal: { level: "none" as const, accuracy: null } };
    expect(feed(target, 0, 5000, () => none)).toEqual([]);
    expect(feed(target, 6000, 6000, () => ({}))).toEqual([]);
    expect(feed(target, 7000, 9000, () => none)).toEqual([{ kind: "gps", change: "lost" }]);
    expect(feed(target, 10_000, 11_000, () => ({}))).toEqual([{ kind: "gps", change: "back" }]);
    expect(feed(target, 12_000, 13_000, () => none, "paused")).toEqual([]);
  });

  it("signals a lost heart-rate source once and its return, and each battery level once", () => {
    const target = monitor();
    expect(target.heartRateSource(true)).toEqual([]);
    expect(target.heartRateSource(false)).toEqual([{ kind: "sensor", change: "lost" }]);
    expect(target.heartRateSource(false)).toEqual([]);
    expect(target.heartRateSource(true)).toEqual([{ kind: "sensor", change: "back" }]);
    expect(target.battery("low")).toEqual([{ kind: "battery", level: "low" }]);
    expect(target.battery("low")).toEqual([]);
    expect(target.battery("critical")).toEqual([{ kind: "battery", level: "critical" }]);
  });

  it("drops the alerts the sport switched off (REC-075)", () => {
    const target = monitor({ settings: { ...noAlerts, disabled: ["lap", "auto_pause", "split"] } });
    expect(target.recorder("lap", lap)).toEqual([]);
    expect(target.recorder("auto_resume", null)).toEqual([]);
    expect(feed(target, 0, 400_000, (t) => ({ distanceMm: t * 3 }))).toEqual([]);
    expect(monitor().recorder("lap", lap)).toEqual([{ kind: "lap", lap }]);
  });

  it("passes the segment entries and passes on unless the sport switched them off (SEG-004)", () => {
    const entered = { kind: "segment_entered", segmentId: "segment" as Id, name: "Côte", bestElapsedMs: null } as const;
    const finished = { kind: "segment_finished", segmentId: "segment" as Id, name: "Côte", elapsedMs: 120_000, bestElapsedMs: 125_000 } as const;
    expect(monitor().segments([entered, finished])).toEqual([entered, finished]);
    expect(monitor().segments([])).toEqual([]);
    expect(monitor({ settings: { ...noAlerts, disabled: ["segment"] } }).segments([entered, finished])).toEqual([]);
  });
});
