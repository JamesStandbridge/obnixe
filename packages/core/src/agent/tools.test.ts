import { asc, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { agentCall, agentConnection, changeset, exercise, painReport, programSlot, programVersion, session, sessionItem, settings, strengthSet } from "@obnixe/schema";
import type { EpochMs, Id, LocalDate } from "@obnixe/schema";
import { createTestContext } from "../testing.ts";
import type { TestContext } from "../testing.ts";
import { commit } from "../writer.ts";
import type { Actor } from "../writer.ts";
import { closeConnection, closeDanglingConnections, openConnection } from "./connection.ts";
import { runAgentTool } from "./dispatch.ts";
import { loadRevertIndex, revertState, toggleChange } from "./history.ts";
import type { ToolOutcome } from "./protocol.ts";

const user: Actor = { author: "user", connectionId: null };
const timeZone = "Europe/Paris";

let context: TestContext;
let connectionId: Id;

interface Permissions {
  readonly agentCanReadBody: boolean;
  readonly agentCanWrite: boolean;
  readonly agentCanReadPhotos: boolean;
}

function allow(permissions: Partial<Permissions>): void {
  context.db.update(settings).set(permissions).run();
}

beforeEach(() => {
  context = createTestContext();
  context.db
    .insert(settings)
    .values({
      singleton: 1,
      theme: "dark",
      massUnit: "kg",
      agentCanReadBody: false,
      agentCanWrite: false,
      agentCanReadPhotos: false,
      reminderWeekdays: 0,
      reminderMinutes: 1110,
      remindersExportedAt: null,
      agentChangesSeenAt: null,
      bridgeHost: null,
      updatedAt: context.env.now(),
    })
    .run();
  connectionId = openConnection(context.db, context.env, { client: "Cursor", host: "MacBook Pro" });
});

function call(tool: string, args: unknown): ToolOutcome {
  return runAgentTool(context.db, context.env, { connectionId, tool, arguments: args, timeZone });
}

function ok<T>(tool: string, args: unknown): T {
  const outcome = call(tool, args);
  if (outcome.isError) throw new Error(`${tool} failed: ${outcome.text}`);
  return JSON.parse(outcome.text) as T;
}

function calls(): { tool: string; kind: string; summary: string; changesetId: Id | null }[] {
  return context.db.select({ tool: agentCall.tool, kind: agentCall.kind, summary: agentCall.summary, changesetId: agentCall.changesetId }).from(agentCall).orderBy(asc(agentCall.calledAt)).all();
}

const benchProgram = {
  name: "Base hiver",
  sessionsPerWeek: 3,
  summary: "Programme de base",
  slots: [
    {
      name: "Séance A",
      sport: "strength",
      variants: [
        {
          name: "Salle",
          items: [
            { exercise: "Développé couché", newExercise: { measure: "load_reps", equipment: "barbell" }, sets: 3, repsMin: 6, repsMax: 8, targetRir: 2, restSeconds: 150 },
            { exercise: "Tirage menton", sets: 3, repsMin: 10, repsMax: 12 },
          ],
        },
      ],
    },
    { name: "Footing", sport: "run", targetDurationSeconds: 2100, targetValues: { kind: "easy" }, variants: [] },
  ],
};

interface ProgramTree {
  readonly id: Id;
  readonly latest: {
    readonly number: number;
    readonly slots: readonly { readonly lineageId: string; readonly name: string; readonly variants: readonly { readonly lineageId: string; readonly items: readonly { readonly lineageId: string; readonly exercise: string }[] }[] }[];
  };
}

describe("permissions", () => {
  it("refuses writes until the user allows them, without journaling anything", () => {
    const outcome = call("log_activity", { sport: "bike", startedAt: "2026-10-10T09:00:00+02:00", durationSeconds: 3600, values: { distance: 32000 } });
    expect(outcome.isError).toBe(true);
    expect(outcome.text).toContain("Modifier directement");
    expect(context.db.select().from(session).all()).toHaveLength(0);
    expect(calls()).toHaveLength(0);
  });

  it("includes weight only with body permission", () => {
    commit(context.db, context.env, {
      actor: user,
      summary: "Pesée",
      revertsId: null,
      mutations: [{ kind: "insert", table: "weigh_in", row: { id: context.env.newId(), occurredAt: context.env.now(), localDate: "2026-10-20" as LocalDate, timeZone, grams: 78400, deletedAt: null } }],
    });
    const hidden = ok<{ bodyIncluded: boolean; weighIns?: unknown }>("get_body_signals", { from: "2026-09-25", to: "2026-10-24" });
    expect(hidden.bodyIncluded).toBe(false);
    expect(hidden.weighIns).toBeUndefined();
    allow({ agentCanReadBody: true });
    const shown = ok<{ bodyIncluded: boolean; weighIns: { grams: number }[] }>("get_body_signals", { from: "2026-09-25", to: "2026-10-24" });
    expect(shown.weighIns).toEqual([{ localDate: "2026-10-20", grams: 78400 }]);
    expect(calls().map((row) => row.summary)).toEqual(["Douleurs et check-ins, 30 jours", "Douleurs, check-ins et poids, 30 jours"]);
  });

  it("applies permission changes to an open connection immediately", () => {
    const activity = { sport: "bike", startedAt: "2026-10-10T09:00:00+02:00", durationSeconds: 3600, values: { distance: 32000 } };
    allow({ agentCanWrite: true });
    expect(call("log_activity", activity).isError).toBe(false);
    allow({ agentCanWrite: false });
    const revoked = call("log_activity", activity);
    expect(revoked.isError).toBe(true);
    expect(revoked.text).toContain("Modifier directement");
    expect(context.db.select().from(session).all()).toHaveLength(1);
  });

  it("gates photos", () => {
    expect(call("list_photos", {}).isError).toBe(true);
    allow({ agentCanReadPhotos: true });
    expect(ok<{ photos: unknown[] }>("list_photos", {}).photos).toEqual([]);
  });

  it("refuses calls on a closed connection and unknown tools", () => {
    expect(call("drop_everything", {}).text).toContain("Unknown tool");
    closeConnection(context.db, context.env, connectionId, "user");
    expect(call("list_sports", {}).text).toContain("closed");
  });
});

describe("validation", () => {
  beforeEach(() => allow({ agentCanWrite: true }));

  it("returns zod issues as tool errors", () => {
    const outcome = call("get_history", { from: "2026-10-24", to: "2026-10-01" });
    expect(outcome.isError).toBe(true);
    expect(outcome.text).toContain("must not be after");
  });

  it("validates activity values against the sport catalog", () => {
    const outcome = call("log_activity", { sport: "run", startedAt: "2026-10-12T18:00:00+02:00", durationSeconds: 2700, values: { distance: 9200, kind: "sprint" } });
    expect(outcome.isError).toBe(true);
    expect(outcome.text).toContain("kind");
    const items = call("log_activity", { sport: "run", startedAt: "2026-10-12T18:00:00+02:00", durationSeconds: 2700, items: [{ grade: "6a" }] });
    expect(items.text).toContain("no items");
    expect(context.db.select().from(session).all()).toHaveLength(0);
  });

  it("refuses sessions in the future", () => {
    expect(call("log_activity", { sport: "yoga", startedAt: "2026-10-25T09:00:00+02:00", durationSeconds: 3600 }).text).toContain("future");
  });

  it("checks strength sets against the exercise measure", () => {
    const outcome = call("log_strength_session", { startedAt: "2026-10-20T18:00:00+02:00", durationSeconds: 3600, exercises: [{ exercise: "Gainage", newExercise: { measure: "duration", equipment: "bodyweight" }, sets: [{ reps: 10 }] }] });
    expect(outcome.text).toContain("durationSeconds");
    expect(context.db.select().from(exercise).all()).toHaveLength(0);
  });
});

describe("writes", () => {
  beforeEach(() => allow({ agentCanWrite: true }));

  it("logs an activity journaled as the agent with a French summary", () => {
    const result = ok<{ sessionId: Id }>("log_activity", { sport: "bike", startedAt: "2026-10-10T09:30:00+02:00", durationSeconds: 5400, values: { distance: 32000, kind: "road" }, effort: "moderate" });
    const row = context.db.select().from(session).where(eq(session.id, result.sessionId)).get();
    expect(row).toMatchObject({ sport: "bike", status: "completed", localDate: "2026-10-10", timeZone, values: { distance: 32000, kind: "road" }, startedAt: Date.parse("2026-10-10T07:30:00Z") });
    const [logged] = calls();
    expect(logged).toMatchObject({ tool: "log_activity", kind: "write", summary: "Vélo du 10 octobre · 32 km" });
    const journal = context.db.select().from(changeset).where(eq(changeset.id, logged?.changesetId ?? ("" as Id))).get();
    expect(journal).toMatchObject({ author: "agent", connectionId, summary: "Vélo du 10 octobre · 32 km" });
  });

  it("logs climbing items validated by the discipline grade scale", () => {
    const bad = call("log_activity", { sport: "climb", startedAt: "2026-10-03T18:00:00+02:00", durationSeconds: 5400, values: { discipline: "boulder" }, items: [{ grade: "french:6a", attempts: 2, result: "sent" }] });
    expect(bad.isError).toBe(true);
    ok("log_activity", {
      sport: "climb",
      startedAt: "2026-10-03T18:00:00+02:00",
      durationSeconds: 5400,
      values: { discipline: "boulder", place: "Arkose" },
      items: [
        { grade: "fontainebleau:6B+", attempts: 3, result: "sent" },
        { grade: "fontainebleau:6C", attempts: 5, result: "project", style: ["overhang"] },
      ],
    });
    expect(context.db.select().from(sessionItem).all()).toHaveLength(2);
    expect(calls().at(-1)?.summary).toBe("Escalade du 3 octobre · 2 blocs");
  });

  it("logs a strength session, creating unknown exercises, and reads it back", () => {
    ok("log_strength_session", {
      startedAt: "2026-10-20T18:00:00+02:00",
      durationSeconds: 4200,
      exercises: [
        { exercise: "Squat", newExercise: { measure: "load_reps", equipment: "barbell" }, sets: [{ loadGrams: 80000, reps: 8, rir: 2 }, { loadGrams: 85000, reps: 6, rir: 1 }] },
        { exercise: "Gainage", newExercise: { measure: "duration", equipment: "bodyweight" }, sets: [{ durationSeconds: 60 }] },
      ],
    });
    expect(calls().at(-1)?.summary).toBe("Musculation du 20 octobre · 2 exercices");
    expect(context.db.select().from(strengthSet).all()).toHaveLength(3);
    const exerciseChangeset = context.db.select().from(changeset).where(eq(changeset.summary, "Exercices ajoutés · Squat, Gainage")).get();
    expect(exerciseChangeset?.author).toBe("agent");

    const history = ok<{ sessions: { sport: string; durationSeconds: number; exercises: { exercise: string; sets: { loadGrams: number | null }[] }[] }[] }>("get_history", { from: "2026-10-01", to: "2026-10-24" });
    expect(history.sessions).toHaveLength(1);
    expect(history.sessions[0]).toMatchObject({ sport: "strength", durationSeconds: 4200 });
    expect(history.sessions[0]?.exercises.map((entry) => entry.exercise)).toEqual(["Squat", "Gainage"]);
    expect(calls().at(-1)?.summary).toBe("Historique des 24 derniers jours");

    const progress = ok<{ sessions: { estimatedOneRepMaxGrams: number; volumeGramReps: number }[] }>("get_exercise_progress", { exercise: "squat" });
    expect(progress.sessions[0]).toMatchObject({ estimatedOneRepMaxGrams: 102000, volumeGramReps: 80000 * 8 + 85000 * 6 });
    expect(calls().at(-1)?.summary).toBe("Progression au squat");
  });

  it("refuses duplicate exercises", () => {
    ok("create_exercise", { name: "Rowing haltère", measure: "load_reps", equipment: "dumbbell", loadStepGrams: 1000, zones: ["lower_back"] });
    expect(call("create_exercise", { name: "rowing  HALTERE", measure: "load_reps", equipment: "dumbbell" }).text).toContain("already exists");
    expect(ok<{ exercises: { name: string; zones: string[] }[] }>("list_exercises", { query: "rowing" }).exercises).toEqual([
      expect.objectContaining({ name: "Rowing haltère", zones: ["lower_back"] }),
    ]);
  });
});

describe("upsert_program", () => {
  beforeEach(() => allow({ agentCanWrite: true }));

  it("creates a draft program and publishes revisions keeping lineages", () => {
    const created = ok<{ programId: Id; versionNumber: number; status: string; createdExercises: { name: string }[] }>("upsert_program", benchProgram);
    expect(created).toMatchObject({ versionNumber: 1, status: "draft" });
    expect(created.createdExercises.map((row) => row.name)).toEqual(["Développé couché", "Tirage menton"]);

    const tree = ok<ProgramTree>("get_program", { programId: created.programId });
    const strengthSlot = tree.latest.slots[0];
    const variant = strengthSlot?.variants[0];
    const bench = variant?.items[0];
    if (strengthSlot === undefined || variant === undefined || bench === undefined) throw new Error("Missing tree");

    const revised = ok<{ versionNumber: number }>("upsert_program", {
      programId: created.programId,
      name: "Base hiver",
      sessionsPerWeek: 3,
      summary: "Rowing haltère au lieu du tirage menton",
      reason: "Gêne à l'épaule droite",
      slots: [
        {
          lineageId: strengthSlot.lineageId,
          name: "Séance A",
          sport: "strength",
          variants: [
            {
              lineageId: variant.lineageId,
              name: "Salle",
              items: [
                { lineageId: bench.lineageId, exercise: "Développé couché", sets: 4, repsMin: 6, repsMax: 8 },
                { exercise: "Rowing haltère", newExercise: { measure: "load_reps", equipment: "dumbbell" }, sets: 3, repsMin: 8, repsMax: 12 },
              ],
            },
          ],
        },
        { lineageId: tree.latest.slots[1]?.lineageId, name: "Footing", sport: "run", targetDurationSeconds: 2400, variants: [] },
      ],
    });
    expect(revised.versionNumber).toBe(2);
    const v2 = ok<ProgramTree>("get_program", { programId: created.programId });
    expect(v2.latest.slots[0]?.lineageId).toBe(strengthSlot.lineageId);
    expect(v2.latest.slots[0]?.variants[0]?.items.map((item) => [item.exercise, item.lineageId === bench.lineageId])).toEqual([
      ["Développé couché", true],
      ["Rowing haltère", false],
    ]);
    const write = calls().find((row) => row.summary === "Rowing haltère au lieu du tirage menton");
    expect(write?.kind).toBe("write");
    const version = context.db.select().from(programVersion).where(eq(programVersion.number, 2)).get();
    expect(version).toMatchObject({ summary: "Rowing haltère au lieu du tirage menton", reason: "Gêne à l'épaule droite", changesetId: write?.changesetId });
  });

  it("rejects unknown lineages and inconsistent slots", () => {
    const created = ok<{ programId: Id }>("upsert_program", benchProgram);
    const unknown = call("upsert_program", { ...benchProgram, programId: created.programId, slots: [{ ...benchProgram.slots[1], lineageId: "nope" }] });
    expect(unknown.text).toContain("Unknown slot lineageId");
    expect(call("upsert_program", { ...benchProgram, slots: [{ name: "Vide", sport: "strength", variants: [] }] }).text).toContain("at least one variant");
    expect(call("upsert_program", { ...benchProgram, slots: [{ ...benchProgram.slots[0], variants: [{ name: "Salle", items: [{ exercise: "Développé couché", sets: 3 }] }] }] }).text).toContain("repsMin");
    expect(context.db.select().from(programVersion).all()).toHaveLength(1);
  });

  it("rolls back inline exercises when the version is rejected", () => {
    const outcome = call("upsert_program", { ...benchProgram, slots: [benchProgram.slots[0], { ...benchProgram.slots[1], targetValues: { kind: "sprint" } }] });
    expect(outcome.isError).toBe(true);
    expect(context.db.select().from(exercise).all()).toHaveLength(0);
    expect(context.db.select().from(changeset).all()).toHaveLength(0);
  });

  it("is undone and redone by the user through the revert chain", () => {
    const created = ok<{ programId: Id }>("upsert_program", benchProgram);
    const tree = ok<ProgramTree>("get_program", { programId: created.programId });
    ok("upsert_program", { ...benchProgram, programId: created.programId, summary: "Footing seul", slots: [{ ...benchProgram.slots[1], lineageId: tree.latest.slots[1]?.lineageId }] });
    const revision = calls().find((row) => row.summary === "Footing seul");
    if (revision?.changesetId == null) throw new Error("Missing revision");

    const undone = toggleChange(context.db, context.env, user, revision.changesetId, "Footing seul");
    expect(undone).toMatchObject({ reverted: true, publishedVersion: true });
    expect(revertState(loadRevertIndex(context.db), revision.changesetId).reverted).toBe(true);
    const restored = ok<ProgramTree>("get_program", { programId: created.programId });
    expect(restored.latest.number).toBe(3);
    expect(restored.latest.slots.map((slot) => slot.name)).toEqual(["Séance A", "Footing"]);

    const redone = toggleChange(context.db, context.env, user, revision.changesetId, "Footing seul");
    expect(redone.reverted).toBe(false);
    expect(revertState(loadRevertIndex(context.db), revision.changesetId).reverted).toBe(false);
    expect(ok<ProgramTree>("get_program", { programId: created.programId }).latest.slots.map((slot) => slot.name)).toEqual(["Footing"]);
    expect(toggleChange(context.db, context.env, user, revision.changesetId, "Footing seul").reverted).toBe(true);

    const reverts = context.db.select().from(changeset).where(eq(changeset.author, "user")).all();
    expect(reverts.map((row) => row.summary)).toEqual(["Annulation : Footing seul", "Rétablissement : Footing seul", "Annulation : Footing seul"]);
  });

  it("undoes a created program entirely", () => {
    ok("upsert_program", benchProgram);
    const [creation] = calls();
    if (creation?.changesetId == null) throw new Error("Missing creation");
    expect(toggleChange(context.db, context.env, user, creation.changesetId, creation.summary).publishedVersion).toBe(false);
    expect(context.db.select().from(programSlot).all()).toHaveLength(0);
    expect(context.db.select().from(exercise).all()).toHaveLength(2);
    expect(ok<{ programs: unknown[] }>("list_programs", {}).programs).toEqual([]);
  });
});

describe("reads", () => {
  it("lists sports with units and history with pain", () => {
    const sportsData = ok<{ sports: { key: string; sessionFields: { key: string; unit?: string }[] }[] }>("list_sports", {});
    expect(sportsData.sports.find((sport) => sport.key === "run")?.sessionFields).toContainEqual(expect.objectContaining({ key: "distance", unit: "meters" }));

    const sessionId = context.env.newId();
    commit(context.db, context.env, {
      actor: user,
      summary: "Course",
      revertsId: null,
      mutations: [
        {
          kind: "insert",
          table: "session",
          row: {
            id: sessionId,
            sport: "run",
            slotId: null,
            variantId: null,
            countsInRotation: false,
            gearId: null,
            title: null,
            status: "completed",
            startedAt: Date.parse("2026-10-12T16:00:00Z") as EpochMs,
            endedAt: Date.parse("2026-10-12T16:50:00Z") as EpochMs,
            pausedSeconds: 120,
            localDate: "2026-10-12" as LocalDate,
            timeZone,
            values: { distance: 9200 },
            effort: "hard",
            sensation: null,
            enjoyment: 4,
            note: null,
            review: "done",
            deletedAt: null,
          },
        },
        {
          kind: "insert",
          table: "pain_report",
          row: {
            id: context.env.newId(),
            zone: "knee_right",
            level: "discomfort",
            occurredAt: context.env.now(),
            localDate: "2026-10-12" as LocalDate,
            timeZone,
            sessionId,
            phase: "end",
            strengthSetId: null,
            sessionItemId: null,
            checkInId: null,
            note: null,
            deletedAt: null,
          },
        },
      ],
    });
    const history = ok<{ sessions: { durationSeconds: number; pain: { zoneLabel: string; level: string }[] }[] }>("get_history", { from: "2026-10-01", to: "2026-10-15", sport: "run" });
    expect(history.sessions[0]?.durationSeconds).toBe(2880);
    expect(history.sessions[0]?.pain).toEqual([expect.objectContaining({ zoneLabel: "Genou droit", level: "discomfort" })]);
    expect(calls().at(-1)?.summary).toBe("Historique du 1er au 15 octobre, course");
    expect(context.db.select().from(painReport).all()).toHaveLength(1);
  });
});

describe("connections", () => {
  it("closes dangling connections at their last call", () => {
    openConnection(context.db, context.env, { client: "Codex", host: "MacBook Pro" });
    ok("list_sports", {});
    const calledAt = context.env.now();
    context.advance(60_000);
    closeDanglingConnections(context.db);
    const rows = context.db.select().from(agentConnection).all();
    expect(rows.every((row) => row.endReason === "screen_closed")).toBe(true);
    expect(rows.find((row) => row.id === connectionId)?.endedAt).toBe(calledAt);
  });
});
