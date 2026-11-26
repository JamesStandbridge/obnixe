import { describe, expect, it } from "vitest";
import { sports } from "@obnixe/schema";
import type { RecordingProfile } from "@obnixe/schema";
import { eastNorthBetween, ellipsoidDistance } from "../geo.ts";
import { createRandom } from "../testing/random.ts";
import { fixAt, origin } from "../testing/fixes.ts";
import { KalmanTrace, minimumSpeedSigma, observeFix, PlanarKalman, UngatedFixError } from "./kalman.ts";
import type { KalmanEstimate, PositionObservation } from "./kalman.ts";

const profile: RecordingProfile = sports.run.recording ?? sports.hike.recording;

interface NoisyLine {
  readonly observations: readonly PositionObservation[];
  /** True east offset of each observation from `origin`, the track running east at 3 m/s. */
  readonly east: readonly number[];
}

function noisyLine(seed: number, count: number, sigma: number): NoisyLine {
  const random = createRandom(seed);
  const observations: PositionObservation[] = [];
  const east: number[] = [];
  for (let index = 0; index < count; index += 1) {
    east.push(3 * index);
    const fix = fixAt(index * 1000, 3 * index + sigma * random.gaussian(), sigma * random.gaussian(), {
      horizontalAccuracyDm: sigma * 10,
      speedCmS: Math.round(300 + 30 * random.gaussian()),
      speedAccuracyCmS: 30,
      bearingCentiDeg: 9000,
    });
    observations.push(observeFix(fix));
  }
  return { observations, east };
}

const errorFromLine = (east: number, latitude: number, longitude: number): number => {
  const offset = eastNorthBetween(origin.latitude, origin.longitude, latitude, longitude);
  return Math.hypot(offset.east - east, offset.north);
};

describe("observeFix", () => {
  it("converts units and builds the Doppler velocity from speed and bearing", () => {
    const observation = observeFix(fixAt(5000, 0, 0, { horizontalAccuracyDm: 42, speedCmS: 500, speedAccuracyCmS: 10, bearingCentiDeg: 9000 }));
    expect(observation.accuracy).toBe(4.2);
    expect(observation.speed).toBe(5);
    expect(observation.velocity?.east).toBeCloseTo(5, 12);
    expect(observation.velocity?.north).toBeCloseTo(0, 12);
    expect(observation.velocity?.sigma).toBe(minimumSpeedSigma);
  });

  it("measures a zero velocity without bearing but no velocity from a moving speed without bearing", () => {
    expect(observeFix(fixAt(0, 0, 0, { speedCmS: 0 })).velocity).toEqual({ east: 0, north: 0, sigma: 0.5 });
    expect(observeFix(fixAt(0, 0, 0, { speedCmS: 120 })).velocity).toBeNull();
  });

  it("refuses an ungated fix", () => {
    expect(() => observeFix(fixAt(0, 0, 0, { horizontalAccuracyDm: null }))).toThrow(UngatedFixError);
  });
});

describe("PlanarKalman", () => {
  it("converges on a constant-velocity track and beats the raw fixes", () => {
    const { observations, east } = noisyLine(4, 120, 8);
    const filter = new PlanarKalman(profile);
    let filteredError = 0;
    let rawError = 0;
    let last: KalmanEstimate | null = null;
    observations.forEach((observation, index) => {
      last = filter.update(observation);
      if (index < 30 || last === null) return;
      filteredError += errorFromLine(east[index] ?? 0, last.latitude, last.longitude) ** 2;
      rawError += errorFromLine(east[index] ?? 0, observation.latitude, observation.longitude) ** 2;
    });
    expect(Math.sqrt(filteredError / 90)).toBeLessThan(Math.sqrt(rawError / 90) / 2);
    expect(filter.estimate?.velocityEast).toBeCloseTo(3, 0);
    expect(Math.abs(filter.estimate?.velocityNorth ?? 1)).toBeLessThan(0.3);
  });

  it("rejects an observation failing the innovation gate and keeps its estimate (GPS-030 rule 4)", () => {
    const { observations } = noisyLine(5, 30, 4);
    const filter = new PlanarKalman(profile);
    for (const observation of observations) filter.update(observation);
    const before = filter.estimate;
    expect(filter.update(observeFix(fixAt(30_000, 90, 40, { horizontalAccuracyDm: 40 })))).toBeNull();
    expect(filter.estimate).toEqual(before);
    expect(filter.update(observeFix(fixAt(31_000, 93, 0, { horizontalAccuracyDm: 40 })))).not.toBeNull();
  });

  it("smooths backward to a lower error than the forward pass (GPS-031)", () => {
    for (const seed of [1, 2, 3]) {
      const { observations, east } = noisyLine(seed, 300, 6);
      const trace = new KalmanTrace();
      const filter = new PlanarKalman(profile, trace);
      let forward = 0;
      observations.forEach((observation, index) => {
        const estimate = filter.update(observation);
        if (estimate !== null) forward += errorFromLine(east[index] ?? 0, estimate.latitude, estimate.longitude) ** 2;
      });
      const smoothed = trace.smoothRts();
      expect(smoothed.length).toBe(trace.length);
      let backward = 0;
      for (let index = 0; index < smoothed.length; index += 1) backward += errorFromLine(east[index] ?? 0, smoothed.latitude[index] ?? 0, smoothed.longitude[index] ?? 0) ** 2;
      expect(backward).toBeLessThan(forward * 0.6);
    }
  });

  it("does not smooth across a restart", () => {
    const { observations } = noisyLine(6, 40, 5);
    const trace = new KalmanTrace();
    const filter = new PlanarKalman(profile, trace);
    const filtered: KalmanEstimate[] = [];
    observations.forEach((observation, index) => {
      const estimate = index === 20 ? filter.reset(observation) : filter.update(observation);
      if (estimate !== null) filtered.push(estimate);
    });
    const smoothed = trace.smoothRts();
    expect([...smoothed.restart].flatMap((flag, index) => (flag === 1 ? [index] : []))).toEqual([0, 20]);
    expect(smoothed.latitude[19]).toBe(filtered[19]?.latitude);
    expect(smoothed.longitude[19]).toBe(filtered[19]?.longitude);
    expect(smoothed.latitude[39]).toBe(filtered[39]?.latitude);
    expect(ellipsoidDistance(smoothed.latitude[10] ?? 0, smoothed.longitude[10] ?? 0, filtered[10]?.latitude ?? 0, filtered[10]?.longitude ?? 0)).toBeGreaterThan(0);
  });

  it("grows its trace past the initial capacity", () => {
    const { observations } = noisyLine(7, 2500, 5);
    const trace = new KalmanTrace();
    const filter = new PlanarKalman(profile, trace);
    const times = observations.flatMap((observation) => (filter.update(observation) === null ? [] : [observation.t]));
    const smoothed = trace.smoothRts();
    expect(times.length).toBeGreaterThan(2400);
    expect([...smoothed.t]).toEqual(times);
  });
});
