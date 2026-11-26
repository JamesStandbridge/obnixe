import { describe, expect, it } from "vitest";
import type { EpochMs, FieldValues, SportKey } from "@obnixe/schema";
import { estimateEnergy, keytelKcalPerMinute, metEntryFor, metTable, minettiGradeBound, minettiRunningCost, minettiWalkingCost } from "./energy.ts";
import type { EnergyActivity, EnergyBody, EnergyPath } from "./energy.ts";
import { heartRateColumns } from "./testing/fixes.ts";
import type { HeartRateColumns } from "./types.ts";

const startedAt = Date.UTC(2026, 5, 1, 7) as EpochMs;
const body: EnergyBody = { massGrams: 70_000, birthYear: 1986, sex: "male" };
const anonymous: EnergyBody = { massGrams: 70_000, birthYear: null, sex: null };
const minute = 60_000;

/** One point per second over `seconds`, at constant speed on a constant grade. */
function steadyPath(meters: number, seconds: number, grade = 0): EnergyPath {
  const distance = new Float64Array(seconds + 1);
  for (let index = 0; index <= seconds; index += 1) distance[index] = (meters * index) / seconds;
  return { distance, grade: new Float64Array(seconds + 1).fill(grade) };
}

function constantHeartRate(bpm: number, fromMs: number, toMs: number): HeartRateColumns {
  const readings: [number, number][] = [];
  for (let t = fromMs; t < toMs; t += 1000) readings.push([t, bpm]);
  return heartRateColumns(readings);
}

function activity(sport: SportKey, durationMs: number, overrides: Partial<EnergyActivity> = {}): EnergyActivity {
  return {
    sport,
    values: {},
    startedAt,
    elapsed: { startMs: 0, endMs: durationMs },
    moving: [{ startMs: 0, endMs: durationMs }],
    distanceMm: 0,
    path: null,
    heartRate: null,
    descents: null,
    ...overrides,
  };
}

const flatTenK = (overrides: Partial<EnergyActivity> = {}): EnergyActivity => activity("run", 50 * minute, { distanceMm: 10_000_000, path: steadyPath(10_000, 3000), ...overrides });

describe("Minetti costs", () => {
  it("cost 3.6 J/kg/m running and 2.5 J/kg/m walking on the flat, clamped beyond 45 %", () => {
    expect(minettiRunningCost(0)).toBe(3.6);
    expect(minettiWalkingCost(0)).toBe(2.5);
    expect(minettiRunningCost(0.1)).toBeCloseTo(155.4e-5 - 30.4e-4 - 43.3e-3 + 46.3e-2 + 1.95 + 3.6, 12);
    expect(minettiRunningCost(0.8)).toBe(minettiRunningCost(minettiGradeBound));
    expect(minettiWalkingCost(-0.9)).toBe(minettiWalkingCost(-minettiGradeBound));
    for (let grade = -minettiGradeBound; grade <= minettiGradeBound; grade += 0.01) {
      expect(minettiRunningCost(grade)).toBeGreaterThan(0);
      expect(minettiWalkingCost(grade)).toBeGreaterThan(0);
    }
  });
});

describe("estimateEnergy", () => {
  it("estimates a flat 10 km in 50 min at 70 kg without heart rate between 650 and 700 kcal (CAL-002)", () => {
    const estimate = estimateEnergy(flatTenK(), body);
    expect(estimate?.method).toBe("mechanical");
    expect(estimate?.kcal).toBe(Math.round((70 * 3.6 * 10_000) / 4184 + (70 * 50) / 60));
    expect(estimate?.kcal).toBeGreaterThanOrEqual(650);
    expect(estimate?.kcal).toBeLessThanOrEqual(700);
  });

  it("uses Keytel for the same run with a 155 bpm heart rate, man of 40 (CAL-002)", () => {
    const estimate = estimateEnergy(flatTenK({ heartRate: constantHeartRate(155, 0, 50 * minute) }), body);
    expect(estimate).toEqual({ kcal: Math.round(keytelKcalPerMinute("male", 155, 70, 40) * 50), method: "heart_rate", met: null });
  });

  it("needs the birth year and the sex for Keytel", () => {
    expect(estimateEnergy(flatTenK({ heartRate: constantHeartRate(155, 0, 50 * minute) }), anonymous)?.method).toBe("mechanical");
    expect(estimateEnergy(flatTenK({ heartRate: constantHeartRate(155, 0, 50 * minute) }), { ...body, sex: null })?.method).toBe("mechanical");
  });

  it("needs a heart rate over 80 % of the moving time, and extends a covered one to the rest of it", () => {
    expect(estimateEnergy(flatTenK({ heartRate: constantHeartRate(155, 0, 39 * minute) }), body)?.method).toBe("mechanical");
    const partial = estimateEnergy(flatTenK({ heartRate: constantHeartRate(155, 0, 45 * minute) }), body);
    const full = estimateEnergy(flatTenK({ heartRate: constantHeartRate(155, 0, 50 * minute) }), body);
    expect(partial?.method).toBe("heart_rate");
    expect(partial?.kcal).toBe(full?.kcal);
  });

  it("counts covered stops with Keytel and uncovered stops at rest", () => {
    const moving = [{ startMs: 0, endMs: 50 * minute }];
    const elapsed = { startMs: 0, endMs: 60 * minute };
    const heartRate = constantHeartRate(155, 0, 50 * minute);
    const estimate = estimateEnergy(flatTenK({ elapsed, moving, heartRate }), body);
    const heldSeconds = 5 - 1;
    const rate = keytelKcalPerMinute("male", 155, 70, 40);
    expect(estimate?.kcal).toBe(Math.round(rate * (50 + heldSeconds / 60) + (70 * (10 - heldSeconds / 60)) / 60));
  });

  it("uses the resting rate under 90 bpm", () => {
    const estimate = estimateEnergy(activity("walk", 60 * minute, { heartRate: constantHeartRate(80, 0, 60 * minute) }), body);
    expect(estimate).toEqual({ kcal: 70, method: "heart_rate", met: null });
  });

  it("uses the walking cost for walks and adds the hiking pack to the carried mass only (CAL-003)", () => {
    const walk = estimateEnergy(activity("walk", 60 * minute, { path: steadyPath(5000, 3600) }), body);
    expect(walk).toEqual({ kcal: Math.round((70 * 2.5 * 5000) / 4184 + 70), method: "mechanical", met: null });
    const hike = estimateEnergy(activity("hike", 60 * minute, { values: { pack_mass: 10_000 }, path: steadyPath(5000, 3600) }), body);
    expect(hike?.kcal).toBe(Math.round((80 * 2.5 * 5000) / 4184 + 70));
  });

  it("integrates the cost of each counted step on its grade, flat where no grade was computed", () => {
    const path: EnergyPath = { distance: Float64Array.from([0, 100, 100, 200, 300]), grade: Float64Array.from([Number.NaN, 0.1, Number.NaN, Number.NaN, 0.1]) };
    const estimate = estimateEnergy(activity("run", 2 * minute, { path }), anonymous);
    expect(estimate?.kcal).toBe(Math.round((70 * (200 * minettiRunningCost(0.1) + 100 * 3.6)) / 4184 + (70 * 2) / 60));
  });

  it("falls back on the Compendium MET without a track, at rest while stopped", () => {
    const run = estimateEnergy(activity("run", 70 * minute, { moving: [{ startMs: 0, endMs: 60 * minute }] }), body);
    expect(run).toEqual({ kcal: Math.round(10.5 * 70 + (70 * 10) / 60), method: "met", met: metTable.runSelfPaced });
  });

  it("picks the cycling MET from the mean moving speed (CAL-002)", () => {
    const ride = estimateEnergy(activity("bike", 2 * 60 * minute, { values: { kind: "road" }, distanceMm: 50_000_000, path: steadyPath(50_000, 7200) }), body);
    expect(ride).toEqual({ kcal: 10 * 70 * 2, method: "met", met: metTable.bike14To16Mph });
  });

  it("counts the alpine MET over the descents only, at rest on the lifts (CAL-002)", () => {
    const day = activity("alpine_ski", 3 * 60 * minute, { values: { kind: "ski" }, descents: [{ startMs: 30 * minute, endMs: 60 * minute }, { startMs: 90 * minute, endMs: 120 * minute }] });
    expect(estimateEnergy(day, body)).toEqual({ kcal: Math.round(5.3 * 70 + (70 * 120) / 60), method: "met", met: metTable.alpineSki });
    expect(estimateEnergy({ ...day, descents: null }, body)?.kcal).toBe(Math.round(5.3 * 70 * 3));
  });

  it("estimates the new outdoor sports without a mechanical model (CAL-002)", () => {
    const paddle = estimateEnergy(activity("paddle", 60 * minute, { values: { kind: "kayak" }, distanceMm: 8_000_000, path: steadyPath(8000, 3600) }), body);
    expect(paddle).toEqual({ kcal: 5 * 70, method: "met", met: metTable.kayak });
    const touring = estimateEnergy(activity("ski_touring", 60 * minute, { values: { kind: "touring" }, distanceMm: 4_000_000, path: steadyPath(4000, 3600, 0.15) }), body);
    expect(touring?.method).toBe("met");
    expect(touring?.met).toEqual(metTable.skiTouring);
  });

  it("returns nothing for sports that are never recorded", () => {
    expect(estimateEnergy(activity("strength", 60 * minute), body)).toBeNull();
  });
});

describe("metEntryFor", () => {
  const entry = (sport: SportKey, values: FieldValues, speed: number | null = null): string | undefined => metEntryFor(sport, values, speed)?.code;

  it("follows the variant", () => {
    expect(entry("run", { kind: "easy" })).toBe("12020");
    expect(entry("run", { kind: "race" })).toBe("12200");
    expect(entry("trail", { kind: "vertical" })).toBe("12345");
    expect(entry("trail", { kind: "race" })).toBe("12140");
    expect(entry("walk", { kind: "nordic" })).toBe("17304");
    expect(entry("hike", { kind: "snow" })).toBe("19190");
    expect(entry("hike", {})).toBe("17080");
    expect(entry("swim", { kind: "breaststroke", water: "pool" })).toBe("18265");
    expect(entry("swim", { kind: "crawl", water: "open_water" })).toBe("18300");
  });

  it("picks the snow, water and skating entries from the variant and the speed", () => {
    const kmh = 1 / 3.6;
    expect(entry("ski_touring", { kind: "touring" })).toBe("19090");
    expect(entry("ski_touring", { kind: "race" })).toBe("19130");
    expect(entry("nordic_ski", { kind: "skate" }, 20 * kmh)).toBe("19135");
    expect(entry("nordic_ski", { kind: "classic" })).toBe("19090");
    expect(entry("nordic_ski", { kind: "classic" }, 5 * kmh)).toBe("19080");
    expect(entry("nordic_ski", { kind: "classic" }, 10 * kmh)).toBe("19100");
    expect(entry("nordic_ski", { kind: "classic" }, 14 * kmh)).toBe("19110");
    expect(entry("alpine_ski", { kind: "snowboard" })).toBe("19160");
    expect(entry("paddle", { kind: "canoe" })).toBe("18070");
    expect(entry("paddle", { kind: "sup" })).toBe("18365");
    expect(entry("paddle", { kind: "rowing" })).toBe("18050");
    expect(entry("paddle", {})).toBe("18100");
    expect(entry("inline_skate", { kind: "fitness" }, 15 * kmh)).toBe("15591");
    expect(entry("inline_skate", { kind: "fitness" }, 19 * kmh)).toBe("15592");
    expect(entry("inline_skate", { kind: "speed" }, 25 * kmh)).toBe("15594");
    expect(entry("inline_skate", { kind: "speed" })).toBe("15593");
  });

  it("uses the speed bands for outdoor cycling, not for e-bikes, mountain bikes or home trainers", () => {
    const mph = 0.44704;
    expect(entry("bike", { kind: "road" }, 9.9 * mph)).toBe("01010");
    expect(entry("bike", { kind: "road" }, 10 * mph)).toBe("01020");
    expect(entry("bike", { kind: "gravel" }, 12.5 * mph)).toBe("01030");
    expect(entry("bike", { kind: "commute" }, 17 * mph)).toBe("01050");
    expect(entry("bike", {}, 21 * mph)).toBe("01060");
    expect(entry("bike", { kind: "road", e_bike: true }, 21 * mph)).toBe("01084");
    expect(entry("bike", { kind: "mtb" }, 21 * mph)).toBe("01009");
    expect(entry("bike", { kind: "indoor" })).toBe("01200");
    expect(entry("bike", { kind: "gravel" })).toBe("01013");
    expect(entry("bike", { kind: "commute" })).toBe("01011");
    expect(entry("bike", {})).toBe("01014");
  });

  it("gives every value a Compendium code", () => {
    for (const value of Object.values(metTable)) expect(value.code).toMatch(/^\d{5}$/);
  });
});
