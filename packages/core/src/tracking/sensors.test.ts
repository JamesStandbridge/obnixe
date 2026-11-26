import { describe, expect, it } from "vitest";
import type { FieldValues, SportKey } from "@obnixe/schema";
import { axisColumn, chartSeries, metricColumn } from "./charts.ts";
import type { LiveSnapshot } from "./live.ts";
import { defaultRecordingSettings } from "./plans.ts";
import { resolveProfile } from "./profile.ts";
import type { ResolvedProfile } from "./profile.ts";
import {
  cadenceReadings,
  cadenceStepsPerCycle,
  forEachSensorSpan,
  pairedSensorOf,
  powerReadings,
  sensorAverage,
  sensorMaxBetween,
  sensorMeanOver,
  sensorReader,
  sensorRolesOf,
  withSensorDevice,
} from "./sensors.ts";
import type { SensorReadings, SensorRole } from "./sensors.ts";
import { coreScenarios } from "./testing/scenarios.ts";
import type { Scenario } from "./testing/scenarios.ts";
import { runBatch, runLive } from "./testing/run.ts";
import { absentValue, toSampleColumns } from "./types.ts";
import type { CadenceSample, PowerSample, Sample } from "./types.ts";

function profileOf(sport: SportKey, values: FieldValues = {}): ResolvedProfile {
  const profile = resolveProfile(sport, values);
  if (profile === null) throw new Error(`${sport} records no track`);
  return profile;
}

const readings = (pairs: readonly (readonly [number, number])[]): SensorReadings => ({
  length: pairs.length,
  t: Uint32Array.from(pairs, ([t]) => t),
  value: Int32Array.from(pairs, ([, value]) => value),
});

const coastingFromMs = 200_000;
const coastingToMs = 230_000;
const dropoutFromMs = 450_000;
const dropoutToMs = 480_000;

/** A power meter with crank data every second: 220 W at 90 rpm, a coasting stretch at 0 W and 0 rpm, then a 30 s dropout. */
function withPowerMeter(scenario: Scenario): Scenario {
  const end = scenario.samples.at(-1)?.t ?? 0;
  const power: PowerSample[] = [];
  for (let t = 500; t <= end; t += 1000) {
    if (t >= dropoutFromMs && t < dropoutToMs) continue;
    const coasting = t >= coastingFromMs && t < coastingToMs;
    power.push({ type: "power", t, watts: coasting ? 0 : 220, cadence: coasting ? 0 : 90 });
  }
  return { ...scenario, samples: [...scenario.samples, ...power].sort((left, right) => left.t - right.t) };
}

describe("sensor readings (SPT-008)", () => {
  it("hold each reading until the next one for at most 5 s, an absent one ending the hold", () => {
    const spans: number[][] = [];
    forEachSensorSpan(readings([[0, 100], [1000, 110], [9000, absentValue], [9500, 120]]), { startMs: 500, endMs: 12_000 }, (startMs, endMs, value) => spans.push([startMs, endMs, value]));
    expect(spans).toEqual([[500, 1000, 100], [1000, 6000, 110], [9500, 12_000, 120]]);
    const read = sensorReader(readings([[1000, 90], [2000, absentValue], [3000, 95]]));
    expect([500, 1000, 1999, 2500, 3000, 7999, 8000].map(read)).toEqual([null, 90, 90, null, 95, 95, null]);
    expect(sensorMaxBetween(readings([[0, 300], [1000, 450], [2000, absentValue], [3000, 500]]), 500, 3000)).toBe(450);
    expect(sensorMaxBetween(readings([[0, 300]]), 1000, 2000)).toBeNull();
  });

  it("average zero watts but not a zero cadence, and need half of the moving time", () => {
    const pairs = readings([[0, 200], [1000, 0], [2000, 0], [3000, 200]]);
    expect(sensorMeanOver(pairs, { startMs: 0, endMs: 4000 }, "every")).toBe(100);
    expect(sensorMeanOver(pairs, { startMs: 0, endMs: 4000 }, "positive")).toBe(200);
    expect(sensorMeanOver(readings([[0, 0]]), { startMs: 0, endMs: 4000 }, "positive")).toBeNull();
    expect(sensorAverage(200 * 30_000, 30_000, 30_000, 60_000)).toBe(200);
    expect(sensorAverage(200 * 29_000, 29_000, 29_000, 60_000)).toBeNull();
  });

  it("take the cadence sensor first, the crank data of the power meter otherwise", () => {
    const cadence: CadenceSample = { type: "cadence", t: 0, perMinute: 172 };
    const crank: PowerSample = { type: "power", t: 0, watts: 250, cadence: 88 };
    const pedalOnly: PowerSample = { type: "power", t: 0, watts: 250, cadence: null };
    const valuesOf = (samples: readonly Sample[]): number[] | null => {
      const found = cadenceReadings(toSampleColumns(samples));
      return found === null ? null : Array.from(found.value);
    };
    expect(valuesOf([cadence, crank])).toEqual([172]);
    expect(valuesOf([crank])).toEqual([88]);
    expect(valuesOf([pedalOnly])).toBeNull();
    expect(Array.from(powerReadings(toSampleColumns([crank]).power).value)).toEqual([250]);
    expect([cadenceStepsPerCycle("steps"), cadenceStepsPerCycle("none")]).toEqual([2, 1]);
  });

  it("pair the sources each profile shows: no sensor for a swim, the heart rate alone on snow, water and skates (SPT-008)", () => {
    const rolesOf = (sport: SportKey, values: FieldValues = {}): readonly SensorRole[] => sensorRolesOf(profileOf(sport, values));
    expect(rolesOf("run")).toEqual(["heart_rate", "cadence", "power"]);
    expect(rolesOf("trail")).toEqual(["heart_rate", "cadence", "power"]);
    expect(rolesOf("bike", { kind: "mtb" })).toEqual(["heart_rate", "cadence", "power"]);
    expect(rolesOf("hike")).toEqual(["heart_rate", "cadence"]);
    expect(rolesOf("swim", { water: "open_water" })).toEqual([]);
    for (const sport of ["ski_touring", "nordic_ski", "alpine_ski", "paddle", "inline_skate"] as const) expect(rolesOf(sport)).toEqual(["heart_rate"]);
  });

  it("ignore a memorized source the profile does not pair", () => {
    const strap = { id: "C4:7D:2A:10:9E:01", name: "HRM-Pro" };
    const settings = withSensorDevice(withSensorDevice(defaultRecordingSettings(profileOf("run")), "heart_rate", strap), "power", { id: "D1", name: "Stryd" });
    expect(settings).toMatchObject({ heartRateDevice: strap, cadenceDevice: null, powerDevice: { name: "Stryd" } });
    expect(pairedSensorOf(profileOf("run"), settings, "power")?.name).toBe("Stryd");
    expect(pairedSensorOf(profileOf("swim", { water: "open_water" }), settings, "heart_rate")).toBeNull();
    expect(pairedSensorOf(profileOf("paddle"), settings, "power")).toBeNull();
    expect(pairedSensorOf(profileOf("paddle"), settings, "heart_rate")).toEqual(strap);
  });

  it("give a ride its power and crank cadence averages, live and in batch, coasting and dropout included", () => {
    const ride = withPowerMeter(coreScenarios.tunnel90s(4));
    const { summary, splits, laps } = runBatch(ride);
    expect(summary).toMatchObject({ cadenceSource: "sensor", cadenceAvg: 90 });
    expect(summary.powerAvg).toBeGreaterThan(205);
    expect(summary.powerAvg).toBeLessThan(220);
    expect([...splits, ...laps].every((stretch) => stretch.powerAvg !== null && stretch.powerAvg <= 220)).toBe(true);
    const live = runLive(ride);
    const at = (t: number): LiveSnapshot | undefined => live.snapshots.find((snapshot) => snapshot.t >= t);
    expect(at(100_000)).toMatchObject({ power: 220, metrics: expect.objectContaining({ cadence: 90 }) });
    expect(at(coastingFromMs + 10_000)).toMatchObject({ power: 0, metrics: expect.objectContaining({ cadence: 0 }) });
    expect(at(dropoutFromMs + 10_000)?.power).toBeNull();
    expect(at(dropoutFromMs + 10_000)?.metrics.cadence).toBeUndefined();
    expect(Math.abs((live.final.powerAvg ?? 0) - (summary.powerAvg ?? 0))).toBeLessThanOrEqual(2);
    expect(at(100_000)?.metrics).toMatchObject({ power: 220, power_avg: 220 });
    expect(at(dropoutFromMs + 10_000)?.metrics.power).toBeUndefined();
    expect(live.final.metrics.power_avg).toBe(live.final.powerAvg);
  });

  it("chart the power of a ride, broken where the meter drops out (SPT-008)", () => {
    const ride = withPowerMeter(coreScenarios.tunnel90s(4));
    const processed = runBatch(ride);
    const column = metricColumn(processed, profileOf("bike"), toSampleColumns(ride.samples), "power");
    const atTime = (t: number): number => column[processed.series.t.findIndex((seriesT) => seriesT >= t)] ?? Number.NaN;
    expect(atTime(100_000)).toBe(220);
    expect(atTime(coastingFromMs + 10_000)).toBe(0);
    expect(atTime(dropoutFromMs + 10_000)).toBeNaN();
    expect(chartSeries(axisColumn(processed, "time"), column, "power", 600)?.range).toEqual({ min: 0, max: 220 });
    expect(chartSeries(axisColumn(processed, "time"), metricColumn(processed, profileOf("bike"), toSampleColumns(coreScenarios.tunnel90s(4).samples), "power"), "power", 600)).toBeNull();
  });

  it("leave a ride without a sensor with no cadence and no power", () => {
    const { summary } = runBatch(coreScenarios.tunnel90s(4));
    expect(summary).toMatchObject({ cadenceSource: "none", cadenceAvg: null, powerAvg: null });
    const live = runLive(coreScenarios.tunnel90s(4)).final;
    expect(live).toMatchObject({ power: null, powerAvg: null });
    expect(live.metrics.cadence).toBeUndefined();
  });
});
