import { describe, expect, it } from "vitest";
import { mountainBikeMotion, sports } from "@obnixe/schema";
import { resolveProfile } from "./profile.ts";
import { absentValue, toSampleColumns, UnorderedSamplesError } from "./types.ts";
import type { Fix, Sample } from "./types.ts";

describe("resolveProfile", () => {
  it("returns the sport profile tagged with its sport", () => {
    expect(resolveProfile("trail", { kind: "race" })).toEqual({ ...sports.trail.recording, sport: "trail" });
  });

  it("applies the override of the chosen option", () => {
    expect(resolveProfile("bike", { kind: "mtb" })?.motion).toEqual(mountainBikeMotion);
    expect(resolveProfile("bike", { kind: "road" })?.motion).toEqual(sports.bike.recording.motion);
    expect(resolveProfile("bike", {})?.motion).toEqual(sports.bike.recording.motion);
  });

  it("records no track for sports or options without a profile", () => {
    expect(resolveProfile("bike", { kind: "indoor" })).toBeNull();
    expect(resolveProfile("swim", { water: "open_water" })).toBeNull();
    expect(resolveProfile("strength", {})).toBeNull();
  });
});

const fix = (t: number, overrides: Partial<Fix> = {}): Fix => ({
  type: "fix",
  t,
  fixAgeMs: 120,
  latitudeE7: 451_885_000,
  longitudeE7: 57_245_000,
  altitudeEllipsoidMm: 262_000,
  altitudeMslMm: 214_000,
  horizontalAccuracyDm: 38,
  verticalAccuracyDm: 52,
  speedCmS: 310,
  speedAccuracyCmS: 40,
  bearingCentiDeg: 9000,
  bearingAccuracyCentiDeg: 1500,
  simulated: false,
  ...overrides,
});

describe("toSampleColumns", () => {
  it("splits interleaved samples into typed columns", () => {
    const samples: Sample[] = [
      fix(0),
      { type: "pressure", t: 200, pascals: 98_532 },
      { type: "heart_rate", t: 400, bpm: 132, contact: "contact", rrInterval: 465 },
      fix(1000, { altitudeMslMm: null, speedCmS: null, simulated: true }),
      { type: "steps", t: 1000, count: 3 },
      { type: "heart_rate", t: 1400, bpm: 133, contact: "unsupported", rrInterval: null },
    ];
    const columns = toSampleColumns(samples);
    expect(columns.fixes.length).toBe(2);
    expect(Array.from(columns.fixes.t)).toEqual([0, 1000]);
    expect(Array.from(columns.fixes.altitudeMslMm)).toEqual([214_000, absentValue]);
    expect(Array.from(columns.fixes.speedCmS)).toEqual([310, absentValue]);
    expect(Array.from(columns.fixes.simulated)).toEqual([0, 1]);
    expect(Array.from(columns.pressure.pascals)).toEqual([98_532]);
    expect(Array.from(columns.steps.count)).toEqual([3]);
    expect(Array.from(columns.heartRate.bpm)).toEqual([132, 133]);
    expect(Array.from(columns.heartRate.rrInterval)).toEqual([465, absentValue]);
  });

  it("refuses a stream that goes back in time", () => {
    expect(() => toSampleColumns([fix(1000), fix(999)])).toThrow(UnorderedSamplesError);
  });
});
