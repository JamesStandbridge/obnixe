import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { session } from "@obnixe/schema";
import type { EpochMs, Id, LocalDate, SportKey } from "@obnixe/schema";
import { attachSessionMutation, attachableSlots, nextSlot, openSlotsOfSport, planSkipNextSlot } from "./rotation.ts";
import type { NextSlot } from "./rotation.ts";
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

function activeProgram(): Id {
  const programId = context.env.newId();
  write([{ kind: "insert", table: "program", row: { id: programId, status: "active" } }]);
  return programId;
}

function publish(programId: Id, number: number, lineages: readonly string[], sportOf: Readonly<Record<string, SportKey>> = {}): Version {
  const versionId = context.env.newId();
  const slotIds = lineages.map(() => context.env.newId());
  write([
    { kind: "insert", table: "program_version", row: { id: versionId, programId, number, name: "Base", sessionsPerWeek: 3, copiedFromId: null, summary: null, reason: null } },
    ...lineages.map(
      (lineage, position): Mutation => ({
        kind: "insert",
        table: "program_slot",
        row: { id: slotIds[position] as Id, versionId, lineageId: lineage as Id, position, sport: sportOf[lineage] ?? "strength", name: `Séance ${lineage}`, targetDurationSeconds: null, targetEffort: null, targetValues: {} },
      }),
    ),
  ]);
  return { versionId, slotIds };
}

function slotOf(version: Version, index: number): Id {
  const slotId = version.slotIds[index];
  if (slotId === undefined) throw new Error(`No slot ${index}`);
  return slotId;
}

interface SessionSeed {
  readonly slotId: Id | null;
  readonly sport?: SportKey;
  readonly endedAt?: EpochMs;
}

function complete(seed: SessionSeed): Id {
  context.advance(3_600_000);
  const endedAt = seed.endedAt ?? context.env.now();
  const id = context.env.newId();
  write([
    {
      kind: "insert",
      table: "session",
      row: {
        id,
        sport: seed.sport ?? "strength",
        slotId: seed.slotId,
        variantId: null,
        countsInRotation: seed.slotId !== null,
        gearId: null,
        title: null,
        status: "completed",
        startedAt: (endedAt - 1_800_000) as EpochMs,
        endedAt,
        pausedSeconds: 0,
        localDate: "2026-10-24" as LocalDate,
        timeZone: "Europe/Paris",
        values: seed.sport === "climb" ? { discipline: "boulder" } : {},
        effort: null,
        sensation: null,
        enjoyment: null,
        note: null,
        review: "skipped",
        deletedAt: null,
      },
    },
  ]);
  return id;
}

function skip(programId: Id, lineage: string): void {
  context.advance(3_600_000);
  write([{ kind: "insert", table: "rotation_skip", row: { id: context.env.newId(), programId, slotLineageId: lineage as Id, skippedAt: context.env.now(), localDate: "2026-10-25" as LocalDate } }]);
}

function current(): NextSlot {
  const next = nextSlot(context.db);
  if (next === null) throw new Error("No next slot");
  return next;
}

function states(next: NextSlot = current()): string[] {
  return next.cycle.map((entry) => `${entry.slot.lineageId}:${entry.state.kind}`);
}

const request = (): { now: EpochMs; timeZone: string; newId: () => Id } => ({ now: context.env.now(), timeZone: "Europe/Paris", newId: context.env.newId });

describe("nextSlot", () => {
  it("returns nothing without an active program", () => {
    expect(nextSlot(context.db)).toBeNull();
  });

  it("starts with the first slot and every slot pending", () => {
    const programId = activeProgram();
    publish(programId, 1, ["A", "B", "C"]);
    const next = current();
    expect(next.slot.lineageId).toBe("A");
    expect(next.after?.lineageId).toBe("B");
    expect(states(next)).toEqual(["A:next", "B:pending", "C:pending"]);
  });

  it("checks slots done in order and restarts the cycle once all are done", () => {
    const programId = activeProgram();
    const version = publish(programId, 1, ["A", "B", "C"]);
    const first = complete({ slotId: slotOf(version, 0) });
    expect(current().cycle[0]?.state).toEqual({ kind: "done", sessionId: first, at: context.env.now(), localDate: "2026-10-24" });
    expect(states()).toEqual(["A:done", "B:next", "C:pending"]);
    complete({ slotId: slotOf(version, 1) });
    expect(current().slot.lineageId).toBe("C");
    expect(current().after?.lineageId).toBe("A");
    complete({ slotId: slotOf(version, 2) });
    expect(states()).toEqual(["A:next", "B:pending", "C:pending"]);
  });

  it("keeps the first unchecked slot next when later slots are done out of order", () => {
    const programId = activeProgram();
    const version = publish(programId, 1, ["basA", "hautA", "footing", "bloc", "basB", "hautB", "trail"], { footing: "run", bloc: "climb", trail: "run" });
    complete({ slotId: slotOf(version, 0) });
    complete({ slotId: slotOf(version, 2), sport: "run" });
    expect(current().slot.lineageId).toBe("hautA");
    expect(current().after?.lineageId).toBe("bloc");
    complete({ slotId: slotOf(version, 3), sport: "climb" });
    expect(current().slot.lineageId).toBe("hautA");
    expect(current().after?.lineageId).toBe("basB");
    complete({ slotId: slotOf(version, 1) });
    expect(states()).toEqual(["basA:done", "hautA:done", "footing:done", "bloc:done", "basB:next", "hautB:pending", "trail:pending"]);
    expect(current().after?.lineageId).toBe("hautB");
  });

  it("opens a new cycle when a slot already checked is done again", () => {
    const programId = activeProgram();
    const version = publish(programId, 1, ["A", "B", "C"]);
    complete({ slotId: slotOf(version, 0) });
    complete({ slotId: slotOf(version, 1) });
    const again = complete({ slotId: slotOf(version, 0) });
    expect(states()).toEqual(["A:done", "B:next", "C:pending"]);
    expect(current().cycle[0]?.state).toMatchObject({ kind: "done", sessionId: again });
  });

  it("counts a new cycle from slot one, keeping slots checked right after the closure", () => {
    const programId = activeProgram();
    const version = publish(programId, 1, ["A", "B", "C"]);
    complete({ slotId: slotOf(version, 0) });
    complete({ slotId: slotOf(version, 2) });
    complete({ slotId: slotOf(version, 1) });
    expect(states()).toEqual(["A:next", "B:pending", "C:pending"]);
    complete({ slotId: slotOf(version, 1) });
    expect(states()).toEqual(["A:next", "B:done", "C:pending"]);
    expect(current().after?.lineageId).toBe("C");
  });

  it("checks a skipped slot for the cycle", () => {
    const programId = activeProgram();
    const version = publish(programId, 1, ["A", "B", "C"]);
    skip(programId, "A");
    expect(states()).toEqual(["A:skipped", "B:next", "C:pending"]);
    complete({ slotId: slotOf(version, 2) });
    expect(current().slot.lineageId).toBe("B");
    expect(current().after?.lineageId).toBe("A");
    skip(programId, "B");
    expect(states()).toEqual(["A:next", "B:pending", "C:pending"]);
  });

  it("ignores sessions outside the program and deleted ones", () => {
    const programId = activeProgram();
    const version = publish(programId, 1, ["A", "B"]);
    complete({ slotId: null });
    const deleted = complete({ slotId: slotOf(version, 0) });
    write([{ kind: "update", table: "session", key: deleted, patch: { deletedAt: context.env.now() } }]);
    expect(states()).toEqual(["A:next", "B:pending"]);
  });

  it("follows lineages across versions, ignoring removed slots and leaving added ones unchecked", () => {
    const programId = activeProgram();
    const first = publish(programId, 1, ["A", "B", "C", "D"]);
    complete({ slotId: slotOf(first, 0) });
    complete({ slotId: slotOf(first, 1) });
    complete({ slotId: slotOf(first, 1) });
    complete({ slotId: slotOf(first, 3) });
    const second = publish(programId, 2, ["A", "C", "E"]);
    const next = current();
    expect(next.slot.id).toBe(slotOf(second, 1));
    expect(next.after?.lineageId).toBe("E");
    expect(states(next)).toEqual(["A:done", "C:next", "E:pending"]);
  });

  it("closes the cycle when the only slots left unchecked are removed", () => {
    const programId = activeProgram();
    const first = publish(programId, 1, ["A", "B", "C"]);
    complete({ slotId: slotOf(first, 0) });
    complete({ slotId: slotOf(first, 1) });
    publish(programId, 2, ["A", "B"]);
    expect(states()).toEqual(["A:next", "B:pending"]);
  });

  it("starts over when every lineage was replaced", () => {
    const programId = activeProgram();
    const first = publish(programId, 1, ["A", "B", "C"]);
    complete({ slotId: slotOf(first, 1) });
    publish(programId, 2, ["X", "Y"]);
    expect(states()).toEqual(["X:next", "Y:pending"]);
  });

  it("replays a session logged later at the time it ended", () => {
    const programId = activeProgram();
    const version = publish(programId, 1, ["A", "B", "C"]);
    complete({ slotId: slotOf(version, 0) });
    const afterA = context.env.now();
    complete({ slotId: slotOf(version, 1) });
    expect(states()).toEqual(["A:done", "B:done", "C:next"]);
    complete({ slotId: slotOf(version, 1), endedAt: (afterA + 60_000) as EpochMs });
    expect(states()).toEqual(["A:next", "B:done", "C:pending"]);
  });

  it("orders a skip after a session that ended before it, even when logged afterwards", () => {
    const programId = activeProgram();
    const version = publish(programId, 1, ["A", "B", "C"]);
    context.advance(3_600_000);
    const before = context.env.now();
    skip(programId, "A");
    complete({ slotId: slotOf(version, 0), endedAt: before });
    expect(states()).toEqual(["A:skipped", "B:next", "C:pending"]);
  });

  it("always proposes the only slot of a single slot rotation", () => {
    const programId = activeProgram();
    const version = publish(programId, 1, ["A"]);
    expect(current().after).toBeNull();
    complete({ slotId: slotOf(version, 0) });
    expect(states()).toEqual(["A:next"]);
    expect(current().after).toBeNull();
  });

  it("counts a given session as if it were in the rotation", () => {
    const programId = activeProgram();
    const version = publish(programId, 1, ["A", "B"]);
    const done = complete({ slotId: slotOf(version, 0) });
    write([{ kind: "update", table: "session", key: done, patch: { countsInRotation: false } }]);
    expect(current().slot.lineageId).toBe("A");
    expect(nextSlot(context.db, { countingSessionId: done })?.slot.lineageId).toBe("B");
  });
});

describe("attaching sessions", () => {
  it("lists open slots of a sport in order and the attachable ones with checked slots last", () => {
    const programId = activeProgram();
    const version = publish(programId, 1, ["basA", "footing", "bloc", "trail"], { footing: "run", bloc: "climb", trail: "run" });
    complete({ slotId: slotOf(version, 1), sport: "run" });
    const next = current();
    expect(openSlotsOfSport(next, "run").map((entry) => entry.slot.lineageId)).toEqual(["trail"]);
    expect(attachableSlots(next, "run").map((entry) => `${entry.slot.lineageId}:${entry.state.kind}`)).toEqual(["trail:pending", "footing:done"]);
    expect(openSlotsOfSport(next, "strength").map((entry) => entry.state.kind)).toEqual(["next"]);
    expect(openSlotsOfSport(next, "swim")).toEqual([]);
  });

  it("attaches a session to a slot so it checks it, and detaches it out of the program", () => {
    const programId = activeProgram();
    const version = publish(programId, 1, ["A", "footing", "C"], { footing: "run" });
    complete({ slotId: slotOf(version, 0) });
    const run = complete({ slotId: null, sport: "run" });
    const row = context.db.select().from(session).where(eq(session.id, run)).get();
    if (row === undefined) throw new Error("Missing session");
    const attach = attachSessionMutation(row, slotOf(version, 1));
    expect(attach).toEqual({ kind: "update", table: "session", key: run, patch: { slotId: slotOf(version, 1), variantId: null, countsInRotation: true } });
    write([attach]);
    expect(states()).toEqual(["A:done", "footing:done", "C:next"]);
    write([attachSessionMutation({ ...row, slotId: slotOf(version, 1) }, null)]);
    expect(states()).toEqual(["A:done", "footing:next", "C:pending"]);
  });

  it("keeps the variant only when the slot does not change", () => {
    const target = { id: "s" as Id, slotId: "slot" as Id, variantId: "variant" as Id };
    expect(attachSessionMutation(target, "slot" as Id)).toMatchObject({ patch: { slotId: "slot", variantId: "variant", countsInRotation: true } });
    expect(attachSessionMutation(target, "other" as Id)).toMatchObject({ patch: { slotId: "other", variantId: null, countsInRotation: true } });
    expect(attachSessionMutation(target, null)).toMatchObject({ patch: { slotId: null, variantId: null, countsInRotation: false } });
  });
});

describe("planSkipNextSlot", () => {
  it("plans a skip of the next slot that checks it, and nothing for a single slot rotation", () => {
    const programId = activeProgram();
    publish(programId, 1, ["A"]);
    expect(planSkipNextSlot(context.db, request())).toBeNull();
    const second = publish(programId, 2, ["A", "B", "C"]);
    complete({ slotId: slotOf(second, 0) });
    context.advance(60_000);
    const plan = planSkipNextSlot(context.db, request());
    expect(plan?.skipped.lineageId).toBe("B");
    expect(plan?.next.lineageId).toBe("C");
    expect(plan?.mutation).toMatchObject({ kind: "insert", table: "rotation_skip", row: { programId, slotLineageId: "B", skippedAt: context.env.now(), localDate: "2026-10-24" } });
    if (plan === null) throw new Error("Nothing to skip");
    write([plan.mutation]);
    expect(current().slot.lineageId).toBe("C");
    context.advance(60_000);
    const again = planSkipNextSlot(context.db, request());
    expect(again?.next.lineageId).toBe("A");
    if (again === null) throw new Error("Nothing to skip");
    write([again.mutation]);
    expect(states()).toEqual(["A:next", "B:pending", "C:pending"]);
  });
});
