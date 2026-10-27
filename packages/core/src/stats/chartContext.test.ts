import { describe, expect, it } from "vitest";
import type { EpochMs, Id, LocalDate, PainLevel, ZoneKey } from "@obnixe/schema";
import { createTestContext } from "../testing.ts";
import type { Mutation } from "../writer.ts";
import { exerciseVersionMarkers, painSamples, suspensionPeriods, versionMarkers } from "./chartContext.ts";
import type { PainSample, VersionSample } from "./chartContext.ts";
import { Seeder } from "./testing.ts";

const timeZone = "Europe/Paris";

function sample(zone: ZoneKey, level: PainLevel, date: string, hour = 12): PainSample {
  return { zone, level, occurredAt: Date.parse(`${date}T${String(hour).padStart(2, "0")}:00:00Z`) as EpochMs, localDate: date as LocalDate };
}

describe("suspensionPeriods", () => {
  it("opens on the first painful report of a loaded zone and closes once every loaded zone is calm again", () => {
    const periods = suspensionPeriods(
      [
        sample("knee_right", "none", "2026-08-20"),
        sample("knee_right", "discomfort", "2026-09-01"),
        sample("knee_right", "stop", "2026-09-03"),
        sample("knee_right", "none", "2026-09-05"),
        sample("knee_right", "discomfort", "2026-09-12"),
        sample("lower_back", "stop", "2026-09-10"),
        sample("lower_back", "none", "2026-09-14"),
        sample("shoulder_left", "stop", "2026-09-16"),
        sample("knee_right", "none", "2026-09-20", 8),
      ],
      ["knee_right", "lower_back"],
    );
    expect(periods).toEqual([
      { from: "2026-09-01", to: "2026-09-05", zones: ["knee_right"] },
      { from: "2026-09-10", to: "2026-09-20", zones: ["lower_back", "knee_right"] },
    ]);
  });

  it("merges a relapse on the day the previous period ended and leaves the last period open", () => {
    const periods = suspensionPeriods(
      [sample("knee_right", "stop", "2026-10-01"), sample("knee_right", "none", "2026-10-04", 8), sample("knee_right", "discomfort", "2026-10-04", 18)],
      ["knee_right"],
    );
    expect(periods).toEqual([{ from: "2026-10-01", to: null, zones: ["knee_right"] }]);
  });

  it("finds nothing without loaded zones or painful reports", () => {
    expect(suspensionPeriods([sample("knee_right", "stop", "2026-10-01")], [])).toEqual([]);
    expect(suspensionPeriods([sample("knee_right", "none", "2026-10-01")], ["knee_right"])).toEqual([]);
  });

  it("reads painful and calm reports from sessions and check-ins, ignoring trashed ones", () => {
    const seed = new Seeder(createTestContext());
    seed.checkIn("2026-10-01", 3, [{ zone: "knee_right", level: "discomfort" }]);
    seed.checkIn("2026-10-03", 3, [{ zone: "knee_right", level: "none" }]);
    seed.checkIn("2026-10-05", 3, [{ zone: "elbow_left", level: "stop" }]);
    const samples = painSamples(seed.context.db, ["knee_right"]);
    expect(samples.map((item) => [item.localDate, item.level])).toEqual([
      ["2026-10-01", "discomfort"],
      ["2026-10-03", "none"],
    ]);
    expect(suspensionPeriods(samples, ["knee_right"])).toEqual([{ from: "2026-10-01", to: "2026-10-03", zones: ["knee_right"] }]);
  });
});

function version(programId: string, number: number, createdAt: string, exerciseIds: readonly string[]): VersionSample {
  return { programId: programId as Id, number, name: `Base v${number}`, createdAt: Date.parse(createdAt) as EpochMs, exerciseIds: new Set(exerciseIds as Id[]) };
}

describe("versionMarkers", () => {
  it("marks the versions that prescribe the exercise or drop it, one per local day", () => {
    const markers = versionMarkers(
      [
        version("p1", 1, "2026-09-01T08:00:00Z", ["squat"]),
        version("p1", 2, "2026-09-10T08:00:00Z", ["squat", "bench"]),
        version("p1", 3, "2026-09-10T20:00:00Z", ["squat"]),
        version("p1", 4, "2026-09-20T08:00:00Z", ["bench"]),
        version("p1", 5, "2026-09-30T08:00:00Z", ["row"]),
        version("p2", 1, "2026-09-15T08:00:00Z", ["row"]),
        version("p3", 1, "2026-09-25T23:30:00Z", ["squat"]),
      ],
      new Set(["squat" as Id]),
      timeZone,
    );
    expect(markers.map((marker) => [marker.localDate, marker.programId, marker.number])).toEqual([
      ["2026-09-01", "p1", 1],
      ["2026-09-10", "p1", 3],
      ["2026-09-20", "p1", 4],
      ["2026-09-26", "p3", 1],
    ]);
  });

  it("loads versions of followed programs only and counts exercises merged into the target", () => {
    const seed = new Seeder(createTestContext());
    const { context } = seed;
    const squat = seed.exercise("Squat");
    const duplicate = seed.exercise("Squat barre");
    const bench = seed.exercise("Développé couché");
    const base = seed.program("Base", 3, [{ sport: "strength", name: "Séance A", variants: [{ name: "Salle", items: [{ exerciseId: bench, sets: 3, reps: [8, 10] }] }] }]);
    context.advance(86_400_000);
    seed.write(versionRows(seed, base.programId, 2, duplicate));
    context.advance(86_400_000);
    seed.write([{ kind: "update", table: "exercise", key: duplicate, patch: { mergedIntoId: squat, archivedAt: context.env.now() } }]);
    const draft = seed.id();
    seed.write([{ kind: "insert", table: "program", row: { id: draft, status: "draft" } }, ...versionRows(seed, draft, 1, squat)]);

    expect(exerciseVersionMarkers(context.db, squat, timeZone).map((marker) => [marker.localDate, marker.number])).toEqual([["2026-10-25", 2]]);
    expect(exerciseVersionMarkers(context.db, bench, timeZone).map((marker) => [marker.localDate, marker.number])).toEqual([
      ["2026-10-24", 1],
      ["2026-10-25", 2],
    ]);
  });
});

function versionRows(seed: Seeder, programId: Id, number: number, exerciseId: Id): Mutation[] {
  const versionId = seed.id();
  const slotId = seed.id();
  const variantId = seed.id();
  return [
    { kind: "insert", table: "program_version", row: { id: versionId, programId, number, name: "Base", sessionsPerWeek: 3, copiedFromId: null, summary: null, reason: null } },
    { kind: "insert", table: "program_slot", row: { id: slotId, versionId, lineageId: seed.id(), position: 0, sport: "strength", name: "Séance A", targetDurationSeconds: null, targetEffort: null, targetValues: {} } },
    { kind: "insert", table: "program_variant", row: { id: variantId, slotId, lineageId: seed.id(), position: 0, name: "Salle" } },
    {
      kind: "insert",
      table: "program_item",
      row: { id: seed.id(), variantId, lineageId: seed.id(), position: 0, exerciseId, sets: 3, repsMin: 8, repsMax: 10, durationMinSeconds: null, durationMaxSeconds: null, targetRir: 2, restSeconds: null, restAfterSeconds: null },
    },
  ];
}
