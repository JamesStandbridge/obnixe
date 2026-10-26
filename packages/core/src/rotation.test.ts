import { beforeEach, describe, expect, it } from "vitest";
import type { Id, LocalDate } from "@obnixe/schema";
import { nextSlot } from "./rotation.ts";
import { createTestContext } from "./testing.ts";
import type { TestContext } from "./testing.ts";
import { commit } from "./writer.ts";
import type { Mutation } from "./writer.ts";

let context: TestContext;

beforeEach(() => {
  context = createTestContext();
});

function write(mutations: readonly Mutation[]): void {
  commit(context.db, context.env, { actor: { author: "user", connectionId: null }, summary: "Test", revertsId: null, mutations });
}

interface Version {
  readonly versionId: Id;
  readonly slotIds: readonly Id[];
}

function publish(programId: Id, number: number, lineages: readonly string[]): Version {
  const versionId = context.env.newId();
  const slotIds = lineages.map(() => context.env.newId());
  write([
    { kind: "insert", table: "program_version", row: { id: versionId, programId, number, name: "Base", sessionsPerWeek: 3, copiedFromId: null, summary: null, reason: null } },
    ...lineages.map(
      (lineage, position): Mutation => ({
        kind: "insert",
        table: "program_slot",
        row: { id: slotIds[position] as Id, versionId, lineageId: lineage as Id, position, sport: "strength", name: `Séance ${lineage}`, targetDurationSeconds: null, targetEffort: null, targetValues: {} },
      }),
    ),
  ]);
  return { versionId, slotIds };
}

function complete(slotId: Id): void {
  context.advance(3_600_000);
  const startedAt = context.env.now();
  write([
    {
      kind: "insert",
      table: "session",
      row: {
        id: context.env.newId(),
        sport: "strength",
        slotId,
        variantId: null,
        countsInRotation: true,
        gearId: null,
        title: null,
        status: "completed",
        startedAt,
        endedAt: startedAt,
        pausedSeconds: 0,
        localDate: "2026-10-24" as LocalDate,
        timeZone: "Europe/Paris",
        values: {},
        effort: null,
        sensation: null,
        enjoyment: null,
        note: null,
        review: "skipped",
        deletedAt: null,
      },
    },
  ]);
}

describe("nextSlot", () => {
  it("returns nothing without an active program", () => {
    expect(nextSlot(context.db)).toBeNull();
  });

  it("follows the rotation across versions by lineage and honours skips", () => {
    const programId = context.env.newId();
    write([{ kind: "insert", table: "program", row: { id: programId, status: "active" } }]);
    const first = publish(programId, 1, ["A", "B", "C"]);
    expect(nextSlot(context.db)?.slot.lineageId).toBe("A");
    complete(first.slotIds[0] as Id);
    expect(nextSlot(context.db)?.slot.lineageId).toBe("B");
    const second = publish(programId, 2, ["A", "B", "C"]);
    expect(nextSlot(context.db)?.slot.id).toBe(second.slotIds[1]);
    context.advance(3_600_000);
    write([{ kind: "insert", table: "rotation_skip", row: { id: context.env.newId(), programId, slotLineageId: "B" as Id, skippedAt: context.env.now(), localDate: "2026-10-25" as LocalDate } }]);
    expect(nextSlot(context.db)?.slot.lineageId).toBe("C");
    complete(second.slotIds[2] as Id);
    const next = nextSlot(context.db);
    expect(next?.slot.lineageId).toBe("A");
    expect(next?.after?.lineageId).toBe("B");
  });

  it("continues from the old position when the last slot was removed from the program", () => {
    const programId = context.env.newId();
    write([{ kind: "insert", table: "program", row: { id: programId, status: "active" } }]);
    const first = publish(programId, 1, ["A", "B", "C"]);
    complete(first.slotIds[1] as Id);
    publish(programId, 2, ["A", "D", "C"]);
    expect(nextSlot(context.db)?.slot.lineageId).toBe("C");
  });

  it("continues from the position a skipped lineage had in its latest version", () => {
    const programId = context.env.newId();
    write([{ kind: "insert", table: "program", row: { id: programId, status: "active" } }]);
    publish(programId, 1, ["A", "B", "C", "D"]);
    context.advance(3_600_000);
    write([{ kind: "insert", table: "rotation_skip", row: { id: context.env.newId(), programId, slotLineageId: "C" as Id, skippedAt: context.env.now(), localDate: "2026-10-25" as LocalDate } }]);
    publish(programId, 2, ["A", "B", "E", "D"]);
    expect(nextSlot(context.db)?.slot.lineageId).toBe("D");
  });

  it("wraps around when the old position is past the end of the new version", () => {
    const programId = context.env.newId();
    write([{ kind: "insert", table: "program", row: { id: programId, status: "active" } }]);
    const first = publish(programId, 1, ["A", "B", "C", "D"]);
    complete(first.slotIds[3] as Id);
    publish(programId, 2, ["A", "B"]);
    expect(nextSlot(context.db)?.slot.lineageId).toBe("A");
  });
});
