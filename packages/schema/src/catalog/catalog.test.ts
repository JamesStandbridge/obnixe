import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { gradeValue } from "../fields.ts";
import { readoutSchema } from "../recording.ts";
import type { RecordingProfile } from "./recording.ts";
import { catalogSignature, signatureBreaks } from "./signature.ts";
import type { CatalogSnapshot } from "./signature.ts";
import { catalogVersion, itemValuesSchema, sports } from "./sports.ts";
import type { SportDefinition, SportKey } from "./sports.ts";

const snapshot = JSON.parse(readFileSync(new URL("../../catalog.snapshot.json", import.meta.url), "utf8")) as CatalogSnapshot;

describe("catalog", () => {
  it("keeps every published key with the same shape", () => {
    expect(signatureBreaks(snapshot.paths, catalogSignature())).toEqual([]);
  });

  it("has no unpublished key", () => {
    expect(Object.keys(catalogSignature()).filter((path) => !(path in snapshot.paths))).toEqual([]);
  });

  it("publishes the current catalog version", () => {
    expect(snapshot.version).toBe(catalogVersion);
  });

  it.each(Object.entries(sports) as [string, SportDefinition][])("%s is consistent", (_, sport) => {
    const fields = [...sport.sessionFields, ...sport.itemFields];
    const keys = new Set(fields.map((field) => field.key));
    expect(keys.size).toBe(fields.length);
    expect(sport.itemLabel === null).toBe(sport.itemFields.length === 0);
    for (const indicator of sport.indicators) {
      const references = indicator.type === "ratio" ? [indicator.numerator, indicator.denominator] : indicator.type === "aggregate" ? [indicator.field] : [];
      const filter = indicator.type === "ratio" ? null : indicator.filter;
      for (const reference of [...references, ...(filter === null ? [] : [filter.field])]) expect(reference === "duration" || keys.has(reference)).toBe(true);
    }
    if (sport.gradeScaleBy !== null) {
      const discipline = sport.sessionFields.find((field) => field.key === sport.gradeScaleBy?.field);
      expect(discipline?.type).toBe("choice");
      if (discipline?.type === "choice") expect(discipline.options.map((option) => option.key).sort()).toEqual(Object.keys(sport.gradeScaleBy.scales).sort());
    }
  });

  it("grades a climb with the scale of its discipline", () => {
    const boulder = itemValuesSchema(sports.climb, { discipline: "boulder" });
    expect(boulder.safeParse({ grade: gradeValue("fontainebleau", "6B"), attempts: 2, result: "sent" }).success).toBe(true);
    expect(boulder.safeParse({ grade: gradeValue("french", "6b"), attempts: 2, result: "sent" }).success).toBe(false);
  });

  it("records the outdoor sports of V1 and V2 (SPT-001)", () => {
    const recordable = (Object.entries(sports) as [SportKey, SportDefinition][]).filter(([, sport]) => sport.recording !== null).map(([key]) => key);
    expect(recordable.sort()).toEqual(["alpine_ski", "bike", "hike", "inline_skate", "nordic_ski", "paddle", "run", "ski_touring", "swim", "trail", "walk"]);
  });

  it("records an open-water swim only, per 100 m (SPT-009)", () => {
    const swim = sports.swim;
    expect(swim.recordingOverrides).toEqual({ field: "water", byOption: { pool: null } });
    expect(swim.recording?.recordedValues).toEqual({ water: "open_water" });
    expect(swim.recording?.pacePerMeters).toBe(100);
    expect(swim.recording?.splitMeters).toBe(100);
    expect(swim.recording?.autoPauseDefault).toBe(false);
  });

  it.each(Object.entries(sports) as [string, SportDefinition][])("%s records values of its own session fields", (_, sport) => {
    for (const [key, value] of Object.entries(sport.recording?.recordedValues ?? {})) {
      const field = sport.sessionFields.find((candidate) => candidate.key === key);
      expect(field?.type === "choice" ? field.options.map((option) => option.key) : []).toContain(value);
    }
  });

  it.each(recordingProfiles())("%s has a coherent recording profile", (_, profile) => {
    const { motion } = profile;
    expect(motion.startSpeedMmS).toBeGreaterThan(motion.stopSpeedMmS);
    expect(motion.stopSpeedMmS).toBeGreaterThan(0);
    expect(motion.startVerticalMmS === null).toBe(motion.stopVerticalMmS === null);
    if (motion.startVerticalMmS !== null && motion.stopVerticalMmS !== null) expect(motion.startVerticalMmS).toBeGreaterThan(motion.stopVerticalMmS);
    expect(motion.startCadence === null).toBe(motion.stopCadence === null);
    if (motion.startCadence !== null && motion.stopCadence !== null) expect(motion.startCadence).toBeGreaterThan(motion.stopCadence);
    expect(motion.startCadence !== null).toBe(profile.cadence === "steps");
    expect(motion.startAfterMs).toBeGreaterThan(0);
    expect(motion.stopAfterMs).toBeGreaterThanOrEqual(motion.startAfterMs);
    expect(profile.maxSpeedMmS).toBeGreaterThan(motion.startSpeedMmS);
    expect(profile.maxAccelerationMmS2).toBeGreaterThan(0);
    expect(profile.accelerationNoiseMmS2).toBeGreaterThan(0);
    expect(profile.accuracyGateDm).toBeGreaterThan(0);
    expect(profile.speedSmoothingMs).toBeGreaterThan(0);
    expect(profile.splitMeters === null || profile.splitMeters > 0).toBe(true);
    expect(new Set(profile.metrics).size).toBe(profile.metrics.length);
    expect(readoutSchema.safeParse(profile.readout).success).toBe(true);
    for (const metric of [profile.readout.main, ...profile.readout.secondary]) expect(profile.metrics).toContain(metric);
    expect(profile.metrics).toContain("cadence");
    expect(profile.metrics.includes("gap_now")).toBe(profile.gradeAdjustedPace);
    expect(profile.metrics.includes(profile.primary === "pace" ? "pace_now" : "speed_now")).toBe(true);
    expect([...profile.bestEffortMeters].sort((left, right) => left - right)).toEqual(profile.bestEffortMeters);
    expect(profile.bestEffortMeters.every((meters) => meters > 0)).toBe(true);
    expect(profile.bestAscentWindowMs === null || profile.metrics.includes("ascent")).toBe(true);
    expect(profile.climbMinimumAscentMeters === null || (profile.climbMinimumAscentMeters > 0 && profile.metrics.includes("vam"))).toBe(true);
    expect(profile.descentMinimumMeters === null || (profile.descentMinimumMeters > 0 && profile.metrics.includes("descent"))).toBe(true);
  });

  it.each(Object.entries(sports) as [string, SportDefinition][])("%s overrides options of an existing choice field", (_, sport) => {
    const overrides = sport.recordingOverrides;
    if (overrides === null) return;
    expect(sport.recording).not.toBeNull();
    const field = sport.sessionFields.find((candidate) => candidate.key === overrides.field);
    expect(field?.type).toBe("choice");
    const options = field?.type === "choice" ? field.options.map((option) => option.key) : [];
    for (const option of Object.keys(overrides.byOption)) expect(options).toContain(option);
  });
});

function recordingProfiles(): [string, RecordingProfile][] {
  const profiles: [string, RecordingProfile][] = [];
  for (const [key, sport] of Object.entries(sports) as [string, SportDefinition][]) {
    if (sport.recording === null) continue;
    profiles.push([key, sport.recording]);
    for (const [option, override] of Object.entries(sport.recordingOverrides?.byOption ?? {})) {
      if (override !== null) profiles.push([`${key}:${option}`, { ...sport.recording, ...override }]);
    }
  }
  return profiles;
}
