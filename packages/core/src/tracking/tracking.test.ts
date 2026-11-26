import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { mountainBikeMotion, sports } from "@obnixe/schema";
import { resolveProfile } from "./profile.ts";
import { coreScenarios } from "./testing/scenarios.ts";
import { runBatch } from "./testing/run.ts";
import { absentValue, toSampleColumns, UnorderedSamplesError } from "./types.ts";
import type { Fix, Sample } from "./types.ts";

describe("resolveProfile (SPT-002)", () => {
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
    expect(resolveProfile("swim", { water: "pool" })).toBeNull();
    expect(resolveProfile("swim", { water: "open_water" })?.pacePerMeters).toBe(100);
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
  it("splits interleaved samples into typed columns (PRF-031)", () => {
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

  it("PRF-031 keeps every processed series in a typed column", () => {
    const { series } = runBatch(coreScenarios.hrDropout(1));
    for (const [name, column] of Object.entries(series)) {
      if (name === "length" || column === null) continue;
      expect(ArrayBuffer.isView(column), name).toBe(true);
      expect((column as ArrayLike<number>).length, name).toBe(series.length);
    }
  });
});

const trackingDirectory = fileURLToPath(new URL(".", import.meta.url));
/** Validation, storage, DEFLATE and hashing: none of them computes a metric. */
const allowedPackages = new Set(["@obnixe/schema", "drizzle-orm", "zod", "fflate", "@noble/hashes"]);

function packageOf(specifier: string): string {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : (parts[0] ?? specifier);
}

describe("dependencies", () => {
  it("INT-050 implements the processing algorithms without third-party libraries", () => {
    const sources = readdirSync(trackingDirectory, { recursive: true, encoding: "utf8" }).filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"));
    expect(sources.length).toBeGreaterThan(40);
    const imported = new Set<string>();
    for (const file of sources) {
      for (const match of readFileSync(join(trackingDirectory, file), "utf8").matchAll(/(?:^|\n)\s*(?:import|export)\s[^;]*?from\s+"([^"]+)"/g)) {
        const specifier = match[1] ?? "";
        if (!specifier.startsWith(".")) imported.add(packageOf(specifier));
      }
    }
    expect([...imported].filter((name) => !allowedPackages.has(name))).toEqual([]);
  });
});
