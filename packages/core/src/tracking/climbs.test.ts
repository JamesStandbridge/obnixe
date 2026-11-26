import { describe, expect, it } from "vitest";
import type { SportKey } from "@obnixe/schema";
import { intervalCodes, trackClimbRules, trackClimbsOf, trackDescentsOf } from "./stages/derive.ts";
import type { TrackSeries } from "./stages/derive.ts";
import { runBatch } from "./testing/run.ts";
import { buildTruth, clearSky, move, simulate, stop } from "./testing/scenarios.ts";
import type { Leg, Scenario, SensorModel } from "./testing/scenarios.ts";

const barometer: SensorModel = { ...clearSky, barometer: { driftMetersPerHour: 3, sigma: 0.1 } };
const seeds = [1, 2, 3];

function outing(sport: SportKey, legs: readonly Leg[], sensors: SensorModel, seed: number): Scenario {
  const truth = buildTruth({ latitude: 45.1885, longitude: 5.7245, altitude: 400, legs });
  return { sport, truth, ...simulate(truth, sensors, seed) };
}

const near = (value: number, reference: number, tolerance: number): boolean => Math.abs(value - reference) <= tolerance;

interface Ramp {
  readonly meters: number;
  readonly grade: number;
}

/** A moving series at 1 m/s with a point every meter, its D+ the sum of the rises. */
function profileSeries(ramps: readonly Ramp[]): TrackSeries {
  const altitudes = [500];
  for (const ramp of ramps) for (let meter = 0; meter < ramp.meters; meter += 1) altitudes.push((altitudes.at(-1) ?? 0) + ramp.grade);
  const length = altitudes.length;
  const ascent = new Float64Array(length);
  const descent = new Float64Array(length);
  for (let index = 1; index < length; index += 1) {
    const rise = (altitudes[index] ?? 0) - (altitudes[index - 1] ?? 0);
    ascent[index] = (ascent[index - 1] ?? 0) + Math.max(0, rise);
    descent[index] = (descent[index - 1] ?? 0) + Math.max(0, -rise);
  }
  const index = Float64Array.from({ length }, (_, position) => position);
  return {
    length,
    t: Float64Array.from(index, (value) => value * 1000),
    fixIndex: Uint32Array.from(index),
    latitude: new Float64Array(length),
    longitude: new Float64Array(length),
    speed: new Float32Array(length).fill(1),
    altitude: Float32Array.from(altitudes),
    grade: new Float64Array(length).fill(Number.NaN),
    interval: new Uint8Array(length).fill(intervalCodes.moving),
    distance: index,
    moving: Float64Array.from(index, (value) => value * 1000),
    ascent,
    descent,
    gradeAdjustedDistance: null,
    steps: null,
    heartBeats: null,
    heartRateMs: null,
    cadence: null,
    power: null,
  };
}

describe("climbs (GPS-062)", () => {
  it("merges two ramps across a short flat and ignores a bump under the bike minimum", () => {
    const legs = [
      move(1000, 8, 0),
      move(2000, 5, 0, 100),
      move(200, 8, 0),
      move(1000, 5, 0, 40),
      move(1500, 12, 90, -140),
      move(500, 8, 90),
      move(500, 6, 90, 20),
      move(500, 8, 90),
    ];
    for (const seed of seeds) {
      const climbs = runBatch(outing("bike", legs, barometer, seed)).climbs;
      expect(climbs, `seed ${seed}`).toHaveLength(1);
      const climb = climbs[0];
      if (climb === undefined) continue;
      expect(near(climb.startDistanceMm / 1000, 1000, 100), `seed ${seed} start ${climb.startDistanceMm}`).toBe(true);
      expect(near(climb.distanceMm / 1000, 3200, 150), `seed ${seed} length ${climb.distanceMm}`).toBe(true);
      expect(near(climb.ascentMm / 1000, 140, 6), `seed ${seed} ascent ${climb.ascentMm}`).toBe(true);
      expect(near(climb.gradeAvg, 140 / 3200, 0.004), `seed ${seed} grade ${climb.gradeAvg}`).toBe(true);
      expect(near(climb.gradeMax, 0.05, 0.01), `seed ${seed} max ${climb.gradeMax}`).toBe(true);
      expect(near(climb.movingMs, 3200_000 / 5 - 200_000 / 5 + 200_000 / 8, 40_000), `seed ${seed} moving ${climb.movingMs}`).toBe(true);
      expect(climb.vamMetersPerHour, `seed ${seed}`).toBe(Math.round((climb.ascentMm / 1000) * (3_600_000 / climb.movingMs)));
    }
  });

  it("keeps climbs apart across a descent or a long flat, and drops a trail climb under 50 m", () => {
    const legs = [
      move(1500, 1, 0, 150),
      move(300, 2, 0, -30),
      move(800, 1, 0, 60),
      move(600, 1.5, 90),
      move(700, 1, 90, 70),
      move(1000, 2, 180, -250),
      move(600, 1, 180, 40),
    ];
    for (const seed of seeds) {
      const climbs = runBatch(outing("trail", legs, { ...barometer, cadence: 90 }, seed)).climbs;
      expect(
        climbs.map((climb) => Math.round(climb.ascentMm / 10_000) * 10),
        `seed ${seed}`,
      ).toEqual([150, 60, 70]);
      expect(climbs.every((climb) => climb.gradeAvg >= trackClimbRules.minimumGrade)).toBe(true);
    }
  });

  it("finds hiking climbs on GNSS altitude alone, and none for the sports without climbs", () => {
    const legs = [move(500, 1.3, 30), move(2000, 1, 30, 240), stop(120_000), move(2000, 1.6, 210, -240)];
    for (const seed of seeds) {
      const hike = runBatch(outing("hike", legs, clearSky, seed));
      expect(hike.summary.elevationSource).toBe("gnss");
      expect(hike.climbs, `seed ${seed}`).toHaveLength(1);
      expect(near((hike.climbs[0]?.ascentMm ?? 0) / 1000, 240, 15), `seed ${seed}`).toBe(true);
      expect(near((hike.climbs[0]?.distanceMm ?? 0) / 1000, 2000, 150), `seed ${seed}`).toBe(true);
      expect(runBatch(outing("run", legs, clearSky, seed)).climbs).toEqual([]);
      expect(runBatch(outing("walk", legs, clearSky, seed)).climbs).toEqual([]);
    }
  });

  it("applies the grade, merge and descent rules exactly on a clean profile", () => {
    const ramp = (meters: number, grade: number): Ramp => ({ meters, grade });
    const ascents = (ramps: readonly Ramp[], minimum: number): readonly number[] => trackClimbsOf(profileSeries(ramps), minimum).map((climb) => Math.round(climb.ascentMm / 1000));
    expect(ascents([ramp(500, 0), ramp(1000, 0.05), ramp(250, 0), ramp(400, 0.05), ramp(500, 0)], 30)).toEqual([70]);
    expect(ascents([ramp(500, 0), ramp(1000, 0.05), ramp(350, 0), ramp(400, 0.05), ramp(500, 0)], 30)).toEqual([50]);
    expect(ascents([ramp(500, 0), ramp(1000, 0.05), ramp(350, 0), ramp(400, 0.05), ramp(500, 0)], 15)).toEqual([50, 20]);
    expect(ascents([ramp(500, 0), ramp(1000, 0.06), ramp(200, -0.06), ramp(1000, 0.06), ramp(500, 0)], 30)).toEqual([60, 60]);
    expect(ascents([ramp(500, 0), ramp(1000, 0.06), ramp(200, -0.04), ramp(1000, 0.06), ramp(500, 0)], 30)).toEqual([120]);
    expect(ascents([ramp(500, 0), ramp(3000, 0.025), ramp(500, 0)], 30)).toEqual([]);
    const [climb] = trackClimbsOf(profileSeries([ramp(500, 0), ramp(600, 0.04), ramp(200, 0.12), ramp(600, 0.04), ramp(500, 0)]), 30);
    expect(climb?.startDistanceMm).toBe(500_000);
    expect(climb?.distanceMm).toBe(1_400_000);
    expect(climb?.gradeAvg).toBeCloseTo(72 / 1400, 6);
    expect(climb?.gradeMax).toBeCloseTo(0.12, 6);
    expect(climb?.movingMs).toBe(1_400_000);
    expect(climb?.vamMetersPerHour).toBe(Math.round((72 * 3600) / 1400));
  });

  it("finds nothing on the flat", () => {
    const legs = [move(5000, 5, 0), move(5000, 5, 180)];
    for (const seed of seeds) expect(runBatch(outing("bike", legs, { ...clearSky, altitude: { ...clearSky.altitude, sigma: 8 } }, seed)).climbs, `seed ${seed}`).toEqual([]);
  });
});

describe("descents (runs)", () => {
  const ramp = (meters: number, grade: number): Ramp => ({ meters, grade });

  it("splits the runs at a rebound and drops one under the minimum", () => {
    const drops = (ramps: readonly Ramp[], minimum: number): readonly number[] => trackDescentsOf(profileSeries(ramps), minimum).map((run) => Math.round(run.descentMm / 1000));
    expect(drops([ramp(200, 0), ramp(1000, -0.2), ramp(500, 0.4), ramp(800, -0.25), ramp(100, 0)], 30)).toEqual([200, 200]);
    expect(drops([ramp(200, 0), ramp(1000, -0.2), ramp(100, 0.1), ramp(800, -0.25), ramp(100, 0)], 30)).toEqual([400]);
    expect(drops([ramp(200, 0), ramp(100, -0.2), ramp(500, 0.4), ramp(800, -0.25), ramp(100, 0)], 30)).toEqual([200]);
    expect(drops([ramp(1000, 0.1), ramp(500, 0)], 30)).toEqual([]);
    const [run] = trackDescentsOf(profileSeries([ramp(200, 0), ramp(1000, -0.2), ramp(200, 0.4)]), 30);
    expect(run?.startDistanceMm).toBe(200_000);
    expect(run?.distanceMm).toBe(1_000_000);
    expect(run?.movingMs).toBe(1_000_000);
    expect(run?.speedMaxMmS).toBeCloseTo(1000, 0);
  });

  it("finds the alpine runs between lift rides, and none for the sports without them", () => {
    const legs = [move(1500, 4, 0, 300), move(1500, 10, 180, -300), move(1200, 4, 0, 200), move(1000, 9, 180, -200), stop(60_000)];
    for (const seed of seeds) {
      const alpine = runBatch(outing("alpine_ski", legs, barometer, seed));
      expect(alpine.descents, `seed ${seed}`).toHaveLength(2);
      expect(near((alpine.descents[0]?.descentMm ?? 0) / 1000, 300, 15), `seed ${seed} ${alpine.descents[0]?.descentMm}`).toBe(true);
      expect(near((alpine.descents[1]?.descentMm ?? 0) / 1000, 200, 15), `seed ${seed} ${alpine.descents[1]?.descentMm}`).toBe(true);
      expect(near((alpine.descents[0]?.distanceMm ?? 0) / 1000, 1500, 150), `seed ${seed}`).toBe(true);
      expect(alpine.descents.every((run) => (run.speedMaxMmS ?? 0) > 8000)).toBe(true);
      expect(runBatch(outing("hike", legs, barometer, seed)).descents).toEqual([]);
    }
  });
});
