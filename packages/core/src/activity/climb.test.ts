import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { painReport, session, sessionItem } from "@obnixe/schema";
import type { Id, Session } from "@obnixe/schema";
import { createTestContext } from "../testing.ts";
import type { TestContext } from "../testing.ts";
import { DependentRowsError, commit } from "../writer.ts";
import type { Mutation } from "../writer.ts";
import { revert } from "../undo.ts";
import {
  OpenSessionExistsError,
  ScaleChangeError,
  climbDefaults,
  climbItems,
  climbSummary,
  defaultGrade,
  findOpenSession,
  normalizeDraft,
  planClimbItem,
  planClimbItemRemoval,
  planClimbItemUpdate,
  planClimbSettings,
  planClimbStart,
  planSessionCompletion,
  readClimbItem,
  scaleForDiscipline,
} from "./climb.ts";
import type { ClimbItemDraft } from "./climb.ts";
import { sessionPainMutations } from "./pain.ts";

const zone = "Europe/Paris";
let context: TestContext;

beforeEach(() => {
  context = createTestContext();
});

function write(mutations: readonly Mutation[]): Id {
  return commit(context.db, context.env, { actor: { author: "user", connectionId: null }, summary: "Test", revertsId: null, mutations });
}

function current(id: Id): Session {
  const row = context.db.select().from(session).where(eq(session.id, id)).get();
  if (row === undefined) throw new Error("missing session");
  return row;
}

function start(place: string | null = "Arkose Nation", discipline: "boulder" | "lead" = "boulder"): Id {
  const plan = planClimbStart(context.db, context.env, { startedAt: context.env.now(), timeZone: zone, discipline, place, slot: null });
  write([plan.mutation]);
  return plan.sessionId;
}

function add(sessionId: Id, item: ClimbItemDraft, pains: readonly Id[] = []): Id {
  context.advance(60_000);
  const plan = planClimbItem(context.db, context.env, current(sessionId), item, pains);
  write(plan.mutations);
  return plan.itemId;
}

const flash = (grade: string): ClimbItemDraft => ({ grade, attempts: 1, result: "flash", style: [] });

describe("climbing session lifecycle", () => {
  it("opens a single in-progress session and refuses a second one", () => {
    const id = start();
    expect(current(id)).toMatchObject({ sport: "climb", status: "in_progress", endedAt: null, values: { discipline: "boulder", place: "Arkose Nation" } });
    expect(findOpenSession(context.db)?.id).toBe(id);
    expect(() => planClimbStart(context.db, context.env, { startedAt: context.env.now(), timeZone: zone, discipline: "lead", place: null, slot: null })).toThrow(OpenSessionExistsError);
  });

  it("reuses the last discipline and place", () => {
    expect(climbDefaults(context.db)).toEqual({ discipline: "boulder", place: null });
    const id = start("Block'Out", "lead");
    write([planSessionCompletion(context.env, current(id))]);
    expect(climbDefaults(context.db)).toEqual({ discipline: "lead", place: "Block'Out" });
  });

  it("stores items graded in the discipline scale with increasing positions", () => {
    const id = start();
    add(id, flash("5+"));
    add(id, { grade: "6B", attempts: 3, result: "sent", style: ["overhang", "dyno"] });
    const items = climbItems(context.db, id);
    expect(items.map((item) => [item.position, item.values])).toEqual([
      [0, { grade: "fontainebleau:5+", attempts: 1, result: "flash" }],
      [1, { grade: "fontainebleau:6B", attempts: 3, result: "sent", style: ["overhang", "dyno"] }],
    ]);
    expect(readClimbItem(items[1]?.values ?? {})).toEqual({ grade: "6B", attempts: 3, result: "sent", style: ["overhang", "dyno"] });
    expect(scaleForDiscipline("top_rope")).toBe("french");
  });

  it("turns a flash with several attempts into a send", () => {
    expect(normalizeDraft({ grade: "6A", attempts: 2, result: "flash", style: [] }).result).toBe("sent");
    expect(normalizeDraft({ grade: "6A", attempts: 0, result: "project", style: [] }).attempts).toBe(1);
  });

  it("edits and removes items, unanchoring their pains", () => {
    const id = start();
    const first = add(id, flash("6A"));
    const item = climbItems(context.db, id)[0];
    if (item === undefined) throw new Error("missing item");
    write([planClimbItemUpdate(current(id), item, { grade: "6A+", attempts: 4, result: "project", style: ["slab"] })]);
    expect(climbItems(context.db, id)[0]?.values).toEqual({ grade: "fontainebleau:6A+", attempts: 4, result: "project", style: ["slab"] });
    write(sessionPainMutations(context.db, context.env, { sessionId: id, phase: "during", sessionItemId: first, occurredAt: context.env.now(), timeZone: zone }, [{ zone: "fingers_right", level: "discomfort" }]).mutations);
    expect(() => write([{ kind: "delete", table: "session_item", key: first }])).toThrow(DependentRowsError);
    const removal = write(planClimbItemRemoval(context.db, first));
    expect(climbItems(context.db, id)).toHaveLength(0);
    expect(context.db.select().from(painReport).get()?.sessionItemId).toBeNull();
    revert(context.db, context.env, { actor: { author: "user", connectionId: null }, changesetId: removal, summary: "Annulation", restoredVersionSummary: () => "" });
    expect(context.db.select().from(painReport).get()?.sessionItemId).toBe(first);
  });

  it("links pains reported during the draft to the saved item", () => {
    const id = start();
    const pains = sessionPainMutations(context.db, context.env, { sessionId: id, phase: "during", sessionItemId: null, occurredAt: context.env.now(), timeZone: zone }, [{ zone: "elbow_right", level: "discomfort" }]);
    write(pains.mutations);
    const itemId = add(id, flash("6A"), pains.reportIds);
    expect(context.db.select().from(painReport).get()?.sessionItemId).toBe(itemId);
  });

  it("allows discipline changes within the same scale only once items exist", () => {
    const id = start();
    write([planClimbSettings(context.db, current(id), "lead", "Arkose")]);
    expect(current(id).values).toEqual({ discipline: "lead", place: "Arkose" });
    write([planClimbSettings(context.db, current(id), "boulder", null)]);
    add(id, flash("6A"));
    write([planClimbSettings(context.db, current(id), "board", "  ")]);
    expect(current(id).values).toEqual({ discipline: "board" });
    expect(() => planClimbSettings(context.db, current(id), "top_rope", null)).toThrow(ScaleChangeError);
  });

  it("completes the session for review and frees the open slot", () => {
    const id = start();
    context.advance(4_324_000);
    write([planSessionCompletion(context.env, current(id))]);
    expect(current(id)).toMatchObject({ status: "completed", review: "pending", endedAt: context.env.now() });
    expect(findOpenSession(context.db)).toBeNull();
    expect(context.db.select().from(sessionItem).all()).toHaveLength(0);
  });
});

describe("climbing summaries", () => {
  it("derives max sent grade and flash rate from the catalog indicators", () => {
    const items = [
      { grade: "fontainebleau:5", attempts: 1, result: "flash" },
      { grade: "fontainebleau:6A+", attempts: 4, result: "project" },
      { grade: "fontainebleau:6B", attempts: 3, result: "sent" },
      { grade: "fontainebleau:6A", attempts: 1, result: "flash" },
    ];
    expect(climbSummary(items)).toEqual({ count: 4, maxSent: "fontainebleau:6B", flashes: 2, flashRate: 0.5 });
    expect(climbSummary([{ grade: "french:6a", attempts: 2, result: "project" }])).toEqual({ count: 1, maxSent: null, flashes: 0, flashRate: 0 });
    expect(climbSummary([])).toEqual({ count: 0, maxSent: null, flashes: 0, flashRate: null });
  });

  it("proposes a starting grade from recent climbs in the same scale", () => {
    expect(defaultGrade(context.db, "fontainebleau")).toBe("5+");
    const id = start();
    add(id, flash("6B+"));
    add(id, flash("6A"));
    expect(defaultGrade(context.db, "fontainebleau")).toBe("6B+");
    expect(defaultGrade(context.db, "french")).toBe("5c");
  });
});
