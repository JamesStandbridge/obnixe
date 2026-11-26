import { describe, expect, it } from "vitest";
import { buildTruth, clearSky, coreScenarios, heartRateDropouts, move, simulate, stageScenarios, stopAndGoStopsMs, tunnelGap } from "./testing/scenarios.ts";
import type { Route, Scenario, Truth } from "./testing/scenarios.ts";
import { createRandom } from "./testing/random.ts";
import { runBatch, runLive } from "./testing/run.ts";
import { forEachHeartRateSpan, heartRateHoldMs, SpanOverlap } from "./zones.ts";
import { toSampleColumns } from "./types.ts";

const seeds = [1, 2, 3, 4, 5, 6];

interface TruthStop {
  readonly startMs: number;
  readonly endMs: number;
}

function truthStops(truth: Truth): readonly TruthStop[] {
  const stops: TruthStop[] = [];
  let since: number | null = null;
  for (let index = 1; index < truth.length; index += 1) {
    const moving = truth.moving[index] === 1;
    const t = truth.t[index] ?? 0;
    if (!moving && truth.moving[index - 1] === 1) since = t;
    if (moving && since !== null) {
      stops.push({ startMs: since, endMs: t });
      since = null;
    }
  }
  return stops;
}

function truthMovingMs(truth: Truth): number {
  let moving = 0;
  for (let index = 1; index < truth.length; index += 1) if (truth.moving[index] === 1) moving += (truth.t[index] ?? 0) - (truth.t[index - 1] ?? 0);
  return moving;
}

const relativeError = (value: number, reference: number): number => Math.abs(value / reference - 1);

/** `GPS-032`: the live distance at the stop and the recorded one differ by at most max(0.5 %, 20 m). */
function expectLiveMatchesBatch(scenario: Scenario, label: string): void {
  const batch = runBatch(scenario).summary.distanceMm;
  const live = runLive(scenario).final.distanceMm;
  expect(Math.abs(live - batch), label).toBeLessThanOrEqual(Math.max(0.005 * batch, 20_000));
}

describe("tracking core scenarios (TST-010)", { timeout: 60_000 }, () => {
  it("are reproducible from their seed (TST-002)", () => {
    for (const build of Object.values(coreScenarios)) {
      expect(build(3).samples).toEqual(build(3).samples);
      expect(build(3).samples).not.toEqual(build(4).samples);
    }
  });

  it("steady-run measures 10 km within 0.5 % and keeps pace_now within 10 s/km 95 % of the time (GPS-035)", () => {
    for (const seed of seeds) {
      const scenario = coreScenarios.steadyRun(seed);
      expect(relativeError(runBatch(scenario).summary.distanceMm / 1000, scenario.truth.distance), `seed ${seed}`).toBeLessThanOrEqual(0.005);
      const steady = runLive(scenario).snapshots.filter((snapshot) => snapshot.t >= 30_000 && snapshot.t < (scenario.truth.t[scenario.truth.length - 1] ?? 0) - 5000);
      const stable = steady.filter((snapshot) => Math.abs((snapshot.metrics.pace_now ?? 0) - 300) <= 10);
      expect(stable.length / steady.length, `seed ${seed}`).toBeGreaterThanOrEqual(0.95);
    }
  });

  it("track-400m measures 10 laps of lane 1 within 1 % of 4000 m (GPS-041)", () => {
    for (const seed of seeds) {
      expect(relativeError(runBatch(coreScenarios.track400m(seed)).summary.distanceMm / 1000, 4000), `seed ${seed}`).toBeLessThanOrEqual(0.01);
    }
  });

  it("stop-and-go keeps the moving time within 2 s per stop and auto-pauses in time (REC-032)", () => {
    for (const seed of seeds) {
      const scenario = coreScenarios.stopAndGo(seed);
      const stops = truthStops(scenario.truth);
      expect(stops).toHaveLength(stopAndGoStopsMs.length);
      const batch = runBatch(scenario);
      expect(Math.abs(batch.summary.movingMs - truthMovingMs(scenario.truth)), `seed ${seed}`).toBeLessThanOrEqual(2000 * stops.length);
      const live = runLive(scenario);
      for (const stop of stops) {
        const stopped = live.events.find(({ event, arrivalT }) => event.type === "motion_stopped" && arrivalT >= stop.startMs);
        const started = live.events.find(({ event, arrivalT }) => event.type === "motion_started" && arrivalT >= stop.endMs);
        expect((stopped?.arrivalT ?? Infinity) - stop.startMs, `seed ${seed} stop at ${stop.startMs}`).toBeLessThanOrEqual(5000);
        expect((started?.arrivalT ?? Infinity) - stop.endMs, `seed ${seed} resume at ${stop.endMs}`).toBeLessThanOrEqual(3000);
      }
    }
  });

  it("tunnel-90s bridges the gap and measures within 1 % (GPS-040)", () => {
    for (const seed of seeds) {
      const scenario = coreScenarios.tunnel90s(seed);
      const batch = runBatch(scenario);
      expect(relativeError(batch.summary.distanceMm / 1000, scenario.truth.distance), `seed ${seed}`).toBeLessThanOrEqual(0.01);
      const bridged = batch.intervals.filter((interval) => interval.kind === "bridged");
      expect(bridged, `seed ${seed}`).toHaveLength(1);
      expect(bridged[0]?.endMs ?? 0, `seed ${seed}`).toBeGreaterThanOrEqual(tunnelGap.toMs);
      expect(batch.intervals.some((interval) => interval.kind === "gap"), `seed ${seed}`).toBe(false);
    }
  });

  it("forest-canopy never pauses while running under the canopy and stays within 2.5 % (GPS-034, GPS-041)", () => {
    for (const seed of seeds) {
      const scenario = coreScenarios.forestCanopy(seed);
      const batch = runBatch(scenario);
      expect(batch.intervals.filter((interval) => interval.kind === "stopped" || interval.kind === "gap"), `seed ${seed}`).toEqual([]);
      expect(relativeError(batch.summary.distanceMm / 1000, scenario.truth.distance), `seed ${seed}`).toBeLessThanOrEqual(0.025);
      expect(runLive(scenario).events.filter(({ event }) => event.type === "motion_stopped"), `seed ${seed}`).toEqual([]);
    }
  });

  it("long-ride-200km measures within 0.1 % from 43 degrees north", () => {
    for (const seed of [1, 2]) {
      const scenario = coreScenarios.longRide200km(seed);
      expect(relativeError(runBatch(scenario).summary.distanceMm / 1000, scenario.truth.distance), `seed ${seed}`).toBeLessThanOrEqual(0.001);
    }
  });

  it("GPS-010 measures within 1 % at 0.2, 1 and 10 Hz and at irregular intervals", () => {
    const route: Route = { latitude: 45.1885, longitude: 5.7245, altitude: 214, legs: [20, 110, 200, 290].map((bearing) => move(1250, 1000 / 300, bearing)) };
    const sensors = { ...clearSky, accuracy: { min: 4, max: 4, periodMs: 120_000 } };
    for (const intervalMs of [5000, 1000, 100]) {
      const truth = buildTruth(route, intervalMs);
      const scenario: Scenario = { sport: "run", truth, ...simulate(truth, sensors, 7) };
      expect(relativeError(runBatch(scenario).summary.distanceMm / 1000, truth.distance), `${intervalMs} ms`).toBeLessThanOrEqual(0.01);
    }
    const dense = buildTruth(route, 100);
    const simulation = simulate(dense, sensors, 8);
    const random = createRandom(8);
    let nextT = 0;
    const irregular = simulation.samples.filter((sample) => {
      if (sample.t < nextT) return false;
      nextT = sample.t + random.between(200, 5000);
      return true;
    });
    const scenario: Scenario = { sport: "run", truth: dense, samples: irregular, spikes: simulation.spikes };
    expect(relativeError(runBatch(scenario).summary.distanceMm / 1000, dense.distance)).toBeLessThanOrEqual(0.01);
  });

  it("hr-dropout averages the heart rate over the moving time without filling the dropouts (SPT-003)", () => {
    for (const seed of seeds) {
      const scenario = coreScenarios.hrDropout(seed);
      const batch = runBatch(scenario);
      const heartRate = toSampleColumns(scenario.samples).heartRate;
      const overlap = new SpanOverlap(batch.moving);
      let beats = 0;
      let covered = 0;
      forEachHeartRateSpan(heartRate, batch.elapsed, (startMs, endMs, bpm) => {
        const duration = overlap.of(startMs, endMs);
        beats += bpm * duration;
        covered += duration;
      });
      expect(batch.summary.heartRateAvg, `seed ${seed}`).toBe(Math.round(beats / covered));
      const movingMs = batch.summary.movingMs;
      expect(batch.details.heartRateCoveragePermille, `seed ${seed}`).toBe(Math.round((covered * 1000) / movingMs));
      const uncoveredMs = heartRateDropouts.reduce((total, span, index) => total + Math.max(span.toMs - span.fromMs - (index % 2 === 0 ? heartRateHoldMs : 0), 0), 0);
      expect(covered, `seed ${seed}`).toBeLessThanOrEqual(movingMs - uncoveredMs + 1000);
      expect(batch.summary.heartRateMax, `seed ${seed}`).toBeLessThanOrEqual(162);
      const live = runLive(scenario);
      expect(Math.abs((live.final.metrics.heart_rate_avg ?? 0) - beats / covered), `seed ${seed}`).toBeLessThan(1);
      const inDropout = live.snapshots.filter((snapshot) => heartRateDropouts.some((span) => snapshot.t >= span.fromMs + 5000 && snapshot.t < span.toMs));
      expect(inDropout.length, `seed ${seed}`).toBeGreaterThan(0);
      expect(inDropout.filter((snapshot) => snapshot.metrics.heart_rate !== undefined), `seed ${seed}`).toEqual([]);
    }
  });

  it("keep the live distance within max(0.5 %, 20 m) of the recorded one (GPS-032)", () => {
    for (const [name, build] of Object.entries({ ...stageScenarios, ...coreScenarios })) {
      for (const seed of name === "longRide200km" ? [1] : [1, 2, 3]) expectLiveMatchesBatch(build(seed), `${name} seed ${seed}`);
    }
  });
});
