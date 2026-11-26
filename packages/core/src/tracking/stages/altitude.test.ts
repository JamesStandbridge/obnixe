import { describe, expect, it } from "vitest";
import { fixAt } from "../testing/fixes.ts";
import { createRandom } from "../testing/random.ts";
import { grenobleUndulation } from "../testing/scenarios.ts";
import {
  BarometricFusion,
  defaultVerticalSigma,
  distanceMovingAverage,
  ElevationHysteresis,
  geoidUndulation,
  gnssAltitudeFilter,
  GradeMeter,
  gradeSeries,
  maxGrade,
  orthometricAltitude,
  pressureAltitude,
  ScalarKalman,
  VamMeter,
  verticalSigma,
  VerticalSpeedMeter,
} from "./altitude.ts";

/** Inverse of `pressureAltitude`. */
const pressureAt = (altitude: number): number => 101_325 * (1 - altitude / 44_330.77) ** (1 / 0.190263);

describe("geoid", () => {
  it("returns the EGM96 undulation at grid nodes and poles (ELE-001)", () => {
    expect(geoidUndulation(0, 0)).toBeCloseTo(17.16, 2);
    expect(geoidUndulation(90, 0)).toBeCloseTo(13.61, 2);
    expect(geoidUndulation(90, 123.4)).toBeCloseTo(13.61, 2);
    expect(geoidUndulation(-90, 0)).toBeCloseTo(-29.53, 2);
  });

  it("interpolates bilinearly and wraps the longitude (ELE-001)", () => {
    expect(geoidUndulation(45, 5.5)).toBeCloseTo((geoidUndulation(45, 5) + geoidUndulation(45, 6)) / 2, 10);
    expect(geoidUndulation(10, 359.5)).toBeCloseTo(geoidUndulation(10, -0.5), 10);
    expect(geoidUndulation(-33.3, 540.25)).toBeCloseTo(geoidUndulation(-33.3, 180.25), 10);
  });

  it("stays within 1 m of the full-resolution EGM96 model (ELE-001)", () => {
    expect(Math.abs(geoidUndulation(45.1885, 5.7245) - grenobleUndulation)).toBeLessThan(1);
    expect(Math.abs(geoidUndulation(4.7, 78.8) + 106.99)).toBeLessThan(1);
  });

  it("prefers the platform orthometric altitude over the corrected ellipsoidal height (ELE-001)", () => {
    expect(orthometricAltitude(fixAt(0, 0, 0, { altitudeMslMm: 214_000, altitudeEllipsoidMm: 300_000 }))).toBe(214);
    const corrected = orthometricAltitude(fixAt(0, 0, 0, { altitudeEllipsoidMm: 265_000 })) ?? 0;
    expect(corrected).toBeCloseTo(265 - geoidUndulation(45.1885, 5.7245), 4);
    expect(orthometricAltitude(fixAt(0, 0, 0))).toBeNull();
  });

  it("reads the vertical accuracy with a default", () => {
    expect(verticalSigma(fixAt(0, 0, 0, { verticalAccuracyDm: 52 }))).toBe(5.2);
    expect(verticalSigma(fixAt(0, 0, 0))).toBe(defaultVerticalSigma);
    expect(verticalSigma(fixAt(0, 0, 0, { verticalAccuracyDm: 0 }))).toBe(defaultVerticalSigma);
  });
});

describe("altitude filters", () => {
  it("follows the standard atmosphere", () => {
    expect(pressureAltitude(101_325)).toBe(0);
    expect(pressureAltitude(89_874.6)).toBeCloseTo(1000, 0);
    expect(pressureAltitude(pressureAt(2345.6))).toBeCloseTo(2345.6, 6);
  });

  it("smooths a noisy random walk better backward than forward (ELE-002)", () => {
    const random = createRandom(11);
    const filter = gnssAltitudeFilter({ smoothing: true });
    let truth = 500;
    const truths: number[] = [];
    let forward = 0;
    for (let second = 0; second < 1200; second += 1) {
      truth += 0.3 * random.gaussian();
      truths.push(truth);
      forward += (filter.push(second * 1000, truth + 6 * random.gaussian(), 6) - truth) ** 2;
    }
    const smoothed = filter.smoothRts();
    expect(smoothed).toHaveLength(1200);
    expect(smoothed[1199]).toBe(filter.value);
    const backward = truths.reduce((sum, value, index) => sum + ((smoothed[index] ?? 0) - value) ** 2, 0);
    expect(backward).toBeLessThan(forward * 0.7);
  });

  it("keeps no steps without smoothing", () => {
    const filter = new ScalarKalman(1, { smoothing: false });
    expect(filter.value).toBeNull();
    filter.push(0, 3, 1);
    expect(filter.value).toBe(3);
    expect(filter.smoothRts()).toHaveLength(0);
  });

  it("fuses the barometer shape with the GNSS level (ELE-002)", () => {
    const random = createRandom(12);
    const fusion = new BarometricFusion({ smoothing: false });
    expect(fusion.pushGnss(0, 1000, 5)).toBeNull();
    expect(fusion.altitude).toBeNull();
    const altitudeAt = (second: number): number => 1000 + Math.min(Math.max(second - 600, 0), 100) * 0.5;
    let error = 0;
    for (let second = 0; second < 900; second += 1) {
      fusion.pushPressure({ type: "pressure", t: second * 1000, pascals: pressureAt(altitudeAt(second) - 820) });
      fusion.pushGnss(second * 1000, altitudeAt(second) + 5 * random.gaussian(), 5);
      if (second >= 300) error = Math.max(error, Math.abs((fusion.altitude ?? 0) - altitudeAt(second)));
    }
    expect(fusion.barometricAltitude).toBeCloseTo(230, 1);
    expect(error).toBeLessThan(4);
  });

  it("removes the start-up offset transient in batch mode (ELE-002)", () => {
    for (const seed of [13, 14, 15]) {
      const random = createRandom(seed);
      const fusion = new BarometricFusion({ smoothing: true });
      let live = 0;
      for (let second = 0; second < 600; second += 1) {
        fusion.pushPressure({ type: "pressure", t: second * 1000, pascals: pressureAt(200) });
        const fused = fusion.pushGnss(second * 1000, 1000 + 5 * random.gaussian(), 5) ?? 0;
        if (second < 10) live += Math.abs(fused - 1000);
      }
      const smoothed = fusion.smoothRts();
      expect(smoothed).toHaveLength(600);
      const batch = smoothed.subarray(0, 10).reduce((sum, value) => sum + Math.abs(value - 1000), 0);
      expect(batch).toBeLessThan(live / 2);
    }
  });

  it("averages over a distance window and keeps linear profiles", () => {
    const distance = Float64Array.from({ length: 101 }, (_, index) => index * 5);
    const linear = Float64Array.from(distance, (value) => 100 + 0.1 * value);
    const averaged = distanceMovingAverage(distance, linear);
    for (let index = 5; index <= 95; index += 1) expect(averaged[index]).toBeCloseTo(linear[index] ?? 0, 9);
    expect(averaged[0]).toBeCloseTo(101.25, 9);
    const stopped = distanceMovingAverage(new Float64Array(4), Float64Array.from([1, 2, 3, 6]));
    expect([...stopped]).toEqual([3, 3, 3, 3]);
  });
});

describe("ElevationHysteresis", () => {
  it("counts no elevation for noise narrower than the threshold (ELE-010)", () => {
    const random = createRandom(21);
    for (let trial = 0; trial < 1000; trial += 1) {
      const threshold = random.between(1, 8);
      const base = random.between(-100, 3000);
      const hysteresis = new ElevationHysteresis(threshold);
      for (let index = 0; index < 200; index += 1) hysteresis.push(base + random.between(-0.49, 0.49) * threshold, true);
      expect(hysteresis.ascent).toBe(0);
      expect(hysteresis.descent).toBe(0);
    }
  });

  it("balances ascent and descent with the last extremum (ELE-010)", () => {
    const random = createRandom(22);
    for (let trial = 0; trial < 1000; trial += 1) {
      const hysteresis = new ElevationHysteresis(random.between(1, 8));
      const first = random.between(0, 2000);
      let altitude = first;
      hysteresis.push(altitude, true);
      for (let index = 0; index < 300; index += 1) {
        altitude += random.gaussian() * 3;
        hysteresis.push(altitude, random.uniform() > 0.1);
      }
      expect(hysteresis.ascent - hysteresis.descent).toBeCloseTo(hysteresis.extremum - first, 6);
    }
  });

  it("counts a climb in full once it exceeds the threshold and ignores uncounted intervals (ELE-010)", () => {
    const hysteresis = new ElevationHysteresis(2);
    for (const altitude of [100, 101, 101.5, 103, 110, 109]) hysteresis.push(altitude, true);
    expect(hysteresis.ascent).toBe(10);
    hysteresis.push(150, false);
    hysteresis.push(146, true);
    expect(hysteresis.ascent).toBe(10);
    expect(hysteresis.descent).toBe(5);
  });
});

describe("grade, vertical speed and VAM", () => {
  const distance = Float64Array.from({ length: 61 }, (_, index) => index * 2.5);
  const moving = new Uint8Array(61).fill(1);

  it("computes the centered grade over 20 m of distance, bounded and undefined at rest (ELE-020)", () => {
    const grades = gradeSeries(distance, Float64Array.from(distance, (value) => 0.08 * value), moving);
    expect(Number.isNaN(grades[3])).toBe(true);
    expect(grades[4]).toBeCloseTo(0.08, 12);
    expect(grades[56]).toBeCloseTo(0.08, 12);
    expect(Number.isNaN(grades[57])).toBe(true);
    const resting = moving.slice();
    resting[30] = 0;
    expect(Number.isNaN(gradeSeries(distance, Float64Array.from(distance, (value) => 0.08 * value), resting)[30])).toBe(true);
    expect(gradeSeries(distance, Float64Array.from(distance, (value) => 0.9 * value), moving)[30]).toBe(maxGrade);
    expect(gradeSeries(new Float64Array(0), new Float64Array(0), new Uint8Array(0))).toHaveLength(0);
  });

  it("gives live the grade of the point 10 m behind (ELE-020)", () => {
    const altitude = Float64Array.from(distance, (value) => 20 * Math.sin(value / 40));
    const grades = gradeSeries(distance, altitude, moving);
    const meter = new GradeMeter();
    distance.forEach((value, index) => {
      const live = meter.push(value, altitude[index] ?? 0);
      if (index < 8) expect(live).toBeNull();
      else expect(live).toBeCloseTo(grades[index - 4] ?? 0, 12);
    });
  });

  it("derives the vertical speed over a trailing window (ELE-021)", () => {
    const meter = new VerticalSpeedMeter();
    for (let second = 0; second < 14; second += 1) expect(meter.push(second * 1000, 100 + 0.25 * second)).toBeNull();
    for (let second = 15; second < 200; second += 2) expect(meter.push(second * 1000, 100 + 0.25 * second)).toBeCloseTo(0.25, 9);
  });

  it("divides the climb on grades over 3 % by its moving duration (ELE-021)", () => {
    const vam = new VamMeter();
    expect(vam.value).toBeNull();
    vam.push(60_000, 10, 0.1, true);
    vam.push(60_000, 0.5, 0.01, true);
    vam.push(60_000, 30, 0.1, false);
    vam.push(60_000, -1, 0.05, true);
    expect(vam.value).toBe(300);
  });
});
