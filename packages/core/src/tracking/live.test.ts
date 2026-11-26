import { describe, expect, it } from "vitest";
import { ellipsoidDistance } from "./geo.ts";
import { displayStepMeters, elevationProfilePoints, signalLevelOf, signalTimeoutMs } from "./live.ts";
import { coreScenarios } from "./testing/scenarios.ts";
import type { Scenario } from "./testing/scenarios.ts";
import { processTrack } from "./batch.ts";
import { profileOf, runBatch, runLive, trackOf, untrimmed } from "./testing/run.ts";
import type { TrackerMark } from "./types.ts";

const withoutFixesBetween = (scenario: Scenario, fromMs: number, toMs: number): Scenario => ({
  ...scenario,
  samples: scenario.samples.filter((sample) => sample.type !== "fix" || sample.t < fromMs || sample.t >= toMs),
});

describe("LiveTracker", () => {
  it("alternates motion events, starting with the first move (REC-030)", () => {
    const { events } = runLive(coreScenarios.stopAndGo(1));
    const motion = events.flatMap(({ event }) => (event.type === "lap" ? [] : [event]));
    expect(motion[0]?.type).toBe("motion_started");
    motion.forEach((event, index) => expect(event.type).toBe(index % 2 === 0 ? "motion_started" : "motion_stopped"));
    for (let index = 1; index < motion.length; index += 1) expect(motion[index]?.t).toBeGreaterThan(motion[index - 1]?.t ?? 0);
  });

  it("raises automatic laps close to the recorded ones and restarts their count on a manual lap (REC-041)", () => {
    const scenario = coreScenarios.steadyRun(2);
    const marks: TrackerMark[] = [{ kind: "start", t: 0 }, { kind: "lap", t: 450_000 }];
    const autoLap = { trigger: "distance", meters: 1000 } as const;
    const live = runLive(scenario, marks, autoLap);
    const batch = processTrack(trackOf(scenario.samples, marks), profileOf(scenario), { laps: { kind: "recorded", autoLap }, trim: untrimmed });
    const recorded = batch.laps.slice(1).map((lap) => lap.bounds.startOffsetMs).filter((offset) => offset !== 450_000);
    const raised = live.events.flatMap(({ event }) => (event.type === "lap" ? [event.t] : []));
    expect(raised).toHaveLength(recorded.length);
    raised.forEach((t, index) => expect(Math.abs(t - (recorded[index] ?? 0))).toBeLessThan(2000));
    expect(raised.find((t) => t > 450_000)).toBeGreaterThan(450_000 + 290_000);
    expect(live.final.lap.index).toBe(raised.length + 1);
    expect(live.final.lap.distanceMm).toBeLessThan(1_000_000);
  });

  it("keeps every finished lap, adding up to the totals at the current lap start (REC-040)", () => {
    const marks: TrackerMark[] = [{ kind: "start", t: 0 }, { kind: "lap", t: 450_000 }];
    const live = runLive(coreScenarios.steadyRun(2), marks, { trigger: "distance", meters: 1000 });
    const laps = live.tracker.laps;
    expect(laps.map((lap) => lap.index)).toEqual(laps.map((_, index) => index));
    expect(laps.find((lap) => lap.startMs + lap.elapsedMs === 450_000)).toBeDefined();
    laps.slice(1).forEach((lap, index) => expect(lap.startMs).toBeCloseTo((laps[index]?.startMs ?? 0) + (laps[index]?.elapsedMs ?? 0), 6));
    const automatic = laps.filter((lap) => lap.startMs + lap.elapsedMs !== 450_000);
    automatic.forEach((lap) => expect(Math.abs(lap.distanceMm - 1_000_000)).toBeLessThan(2));
    expect(laps.reduce((total, lap) => total + lap.distanceMm, 0)).toBeCloseTo(live.final.distanceMm - live.final.lap.distanceMm, -1);
    expect(laps.reduce((total, lap) => total + lap.movingMs, 0)).toBeCloseTo(live.final.movingMs - live.final.lap.movingMs, -1);
    expect(live.final.lap.index).toBe(laps.length);
  });

  it("stops counting during a manual pause and matches the recorded moving time", () => {
    const scenario = coreScenarios.steadyRun(3);
    const marks: TrackerMark[] = [{ kind: "start", t: 0 }, { kind: "pause", t: 600_000 }, { kind: "resume", t: 900_000 }];
    const live = runLive(scenario, marks);
    const batch = runBatch(scenario, marks);
    expect(Math.abs(live.final.movingMs - batch.summary.movingMs)).toBeLessThan(2000);
    const during = live.snapshots.filter((snapshot) => snapshot.t > 610_000 && snapshot.t < 890_000);
    expect(during.every((snapshot) => snapshot.metrics.pace_now === undefined)).toBe(true);
    const settled = during.filter((snapshot) => snapshot.t > 600_000 + 60_000);
    expect(settled.length).toBeGreaterThan(200);
    expect((settled.at(-1)?.distanceMm ?? 0) - (settled[0]?.distanceMm ?? 0)).toBe(0);
    expect(live.track.some((point) => point.dashed && point.t > 600_000 && point.t < 910_000)).toBe(true);
  });

  it("thins the display track to 2 m and dashes an unfilled gap (GPS-071)", () => {
    const live = runLive(withoutFixesBetween(coreScenarios.steadyRun(4), 600_000, 900_000));
    const dashed = live.track.filter((point) => point.dashed);
    expect(dashed).toHaveLength(1);
    expect(dashed[0]?.t).toBeGreaterThanOrEqual(900_000);
    for (let index = 1; index < live.track.length; index += 1) {
      const point = live.track[index];
      const previous = live.track[index - 1];
      if (point === undefined || previous === undefined || point.dashed) continue;
      expect(ellipsoidDistance(previous.latitude, previous.longitude, point.latitude, point.longitude)).toBeGreaterThanOrEqual(displayStepMeters);
    }
    expect(live.track.length).toBeLessThan(10_000 / displayStepMeters + 10);
  });

  it("draws the elevation profile along the counted distance, bounded in points (UX-002)", () => {
    const trail = runLive(coreScenarios.forestCanopy(6));
    const profile = trail.tracker.elevationProfile;
    expect(profile.length).toBeGreaterThan(200);
    expect(profile.length).toBeLessThanOrEqual(elevationProfilePoints);
    for (let index = 1; index < profile.length; index += 1) expect(profile[index]?.distance).toBeGreaterThan(profile[index - 1]?.distance ?? 0);
    expect(profile.at(-1)?.distance).toBeLessThanOrEqual(trail.final.distanceMm / 1000);
    const altitudes = profile.map((point) => point.altitude);
    expect(Math.max(...altitudes) - Math.min(...altitudes)).toBeGreaterThan(30);
    const ride = runLive(coreScenarios.longRide200km(7)).tracker.elevationProfile;
    expect(ride.length).toBeLessThanOrEqual(elevationProfilePoints);
    expect(ride.length).toBeGreaterThan(elevationProfilePoints / 2);
  });

  it("reports speed and the held heart rate whatever the profile's metrics", () => {
    const run = runLive(coreScenarios.hrDropout(8));
    for (const snapshot of run.snapshots) expect(snapshot.heartRate ?? undefined).toBe(snapshot.metrics.heart_rate);
    expect(run.snapshots.some((snapshot) => snapshot.heartRate !== null)).toBe(true);
    const ride = runLive(coreScenarios.tunnel90s(8)).final;
    expect(ride.metrics.pace_now).toBeUndefined();
    expect(ride.speed).toBeCloseTo(ride.metrics.speed_now ?? 0, 6);
    expect(ride.heartRate).toBeNull();
  });

  it("reports only the profile's metrics (SPT-004)", () => {
    for (const scenario of [coreScenarios.steadyRun(5), coreScenarios.tunnel90s(5)]) {
      const allowed = new Set(profileOf(scenario).metrics);
      const { final, snapshots } = runLive(scenario);
      for (const snapshot of snapshots) for (const key of Object.keys(snapshot.metrics)) expect(allowed.has(key as never)).toBe(true);
      expect(final.metrics.distance).toBeCloseTo(final.distanceMm / 1000, 2);
      expect(final.metrics.moving).toBeCloseTo(final.movingMs, -1);
    }
    const bike = runLive(coreScenarios.tunnel90s(5)).final.metrics;
    expect(bike.pace_now).toBeUndefined();
    expect(bike.speed_avg).toBeGreaterThan(7);
    expect(bike.speed_avg).toBeLessThan(9.5);
  });

  it("grades the signal and loses it without fixes", () => {
    expect([null, 60, 30, 12, 4].map(signalLevelOf)).toEqual(["none", "none", "weak", "fair", "good"]);
    const { tracker, final } = runLive(coreScenarios.steadyRun(6));
    expect(final.signal.level).toBe("good");
    expect(tracker.snapshot(final.t + signalTimeoutMs + 1).signal).toEqual({ level: "none", accuracy: null });
  });
});
