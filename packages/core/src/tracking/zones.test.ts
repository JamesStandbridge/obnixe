import { describe, expect, it } from "vitest";
import type { EpochMs } from "@obnixe/schema";
import { heartRateColumns } from "./testing/fixes.ts";
import type { HeartRateColumns } from "./types.ts";
import { forEachHeartRateSpan, heartRateHoldMs, heartRateZoneOf, heartRateZones, maxHeartRateOf, SpanOverlap, tanakaMaxHeartRate, timeInZones } from "./zones.ts";

const at2026 = Date.UTC(2026, 5, 1) as EpochMs;

function spansOf(heartRate: HeartRateColumns, startMs: number, endMs: number): number[][] {
  const spans: number[][] = [];
  forEachHeartRateSpan(heartRate, { startMs, endMs }, (from, to, bpm) => spans.push([from, to, bpm]));
  return spans;
}

describe("heart-rate zones", () => {
  it("splits 50 to 100 % of the maximum in five zones (CAL-004)", () => {
    const zones = heartRateZones(190);
    expect(zones.map((zone) => [zone.zone, zone.minBpm, zone.maxBpm])).toEqual([
      [1, 95, 114],
      [2, 114, 133],
      [3, 133, 152],
      [4, 152, 171],
      [5, 171, 190],
    ]);
    expect(heartRateZoneOf(94.9, zones)).toBeNull();
    expect(heartRateZoneOf(95, zones)).toBe(1);
    expect(heartRateZoneOf(151, zones)).toBe(3);
    expect(heartRateZoneOf(152, zones)).toBe(4);
    expect(heartRateZoneOf(205, zones)).toBe(5);
  });

  it("prefers the set maximum over the Tanaka estimate (CAL-004)", () => {
    expect(tanakaMaxHeartRate(40)).toBe(180);
    expect(maxHeartRateOf({ birthYear: 1986, sex: null, maxHeartRate: null }, at2026)).toBe(180);
    expect(maxHeartRateOf({ birthYear: 1986, sex: "male", maxHeartRate: 192 }, at2026)).toBe(192);
    expect(maxHeartRateOf({ birthYear: null, sex: null, maxHeartRate: null }, at2026)).toBeNull();
  });
});

describe("forEachHeartRateSpan", () => {
  it("holds each reading until the next one, at most the hold time, and never fills a dropout", () => {
    const heartRate = heartRateColumns([
      [0, 120],
      [1000, 125],
      [2000, 0],
      [3000, 130],
      [20_000, 140],
    ]);
    expect(spansOf(heartRate, 0, 100_000)).toEqual([
      [0, 1000, 120],
      [1000, 2000, 125],
      [3000, 3000 + heartRateHoldMs, 130],
      [20_000, 20_000 + heartRateHoldMs, 140],
    ]);
  });

  it("clips the spans to the window", () => {
    const heartRate = heartRateColumns([
      [0, 120],
      [1000, 125],
      [2000, 130],
    ]);
    expect(spansOf(heartRate, 500, 2500)).toEqual([
      [500, 1000, 120],
      [1000, 2000, 125],
      [2000, 2500, 130],
    ]);
  });
});

describe("SpanOverlap", () => {
  it("measures successive intervals against sorted spans", () => {
    const overlap = new SpanOverlap([
      { startMs: 10, endMs: 20 },
      { startMs: 30, endMs: 40 },
    ]);
    expect(overlap.of(0, 5)).toBe(0);
    expect(overlap.of(5, 15)).toBe(5);
    expect(overlap.of(15, 35)).toBe(10);
    expect(overlap.of(35, 50)).toBe(5);
    expect(overlap.of(50, 60)).toBe(0);
  });
});

describe("timeInZones", () => {
  it("counts the time each zone holds inside the requested spans", () => {
    const zones = heartRateZones(200);
    const heartRate = heartRateColumns([
      [0, 90],
      [1000, 110],
      [3000, 150],
      [6000, 190],
      [7000, 0],
    ]);
    const result = timeInZones(heartRate, zones, [
      { startMs: 0, endMs: 4000 },
      { startMs: 5000, endMs: 8000 },
    ]);
    expect(result).toEqual({ coveredMs: 6000, belowMs: 1000, byZone: { 1: 2000, 2: 0, 3: 2000, 4: 0, 5: 1000 } });
  });
});
