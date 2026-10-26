import { asc, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { agentCall, changeset, exercise, exerciseZone, painReport, program, programItem, session, sessionItem, settings, strengthEntry, strengthSet } from "@obnixe/schema";
import type { EpochMs, Id, LocalDate, PainReport, Session } from "@obnixe/schema";
import { trashItems } from "../data/trash.ts";
import { createTestContext } from "../testing.ts";
import type { TestContext } from "../testing.ts";
import { commit } from "../writer.ts";
import type { Actor, NewRow } from "../writer.ts";
import { openConnection } from "./connection.ts";
import { runAgentTool } from "./dispatch.ts";
import { toggleChange } from "./history.ts";
import type { ToolOutcome } from "./protocol.ts";

const user: Actor = { author: "user", connectionId: null };
const timeZone = "Europe/Paris";

let context: TestContext;
let connectionId: Id;

beforeEach(() => {
  context = createTestContext();
  context.db
    .insert(settings)
    .values({
      singleton: 1,
      theme: "dark",
      massUnit: "kg",
      agentCanReadBody: false,
      agentCanWrite: true,
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
  context.advance(1000);
  return runAgentTool(context.db, context.env, { connectionId, tool, arguments: args, timeZone });
}

function ok<T>(tool: string, args: unknown): T {
  const outcome = call(tool, args);
  if (outcome.isError) throw new Error(`${tool} failed: ${outcome.text}`);
  return JSON.parse(outcome.text) as T;
}

function failed(tool: string, args: unknown): string {
  const outcome = call(tool, args);
  expect(outcome.isError).toBe(true);
  return outcome.text;
}

interface LastCall {
  readonly summary: string;
  readonly changesetId: Id;
}

function lastCall(): LastCall {
  const row = context.db
    .select({ summary: agentCall.summary, changesetId: agentCall.changesetId })
    .from(agentCall)
    .where(eq(agentCall.kind, "write"))
    .orderBy(asc(agentCall.calledAt))
    .all()
    .at(-1);
  if (row?.changesetId == null) throw new Error("No write call");
  return { summary: row.summary, changesetId: row.changesetId };
}

function undoLast(): void {
  const last = lastCall();
  toggleChange(context.db, context.env, user, last.changesetId, last.summary);
}

function sessionRow(sessionId: Id): Session {
  const row = context.db.select().from(session).where(eq(session.id, sessionId)).get();
  if (row === undefined) throw new Error(`Missing session ${sessionId}`);
  return row;
}

function painRow(sessionId: Id, anchor: Pick<PainReport, "strengthSetId" | "sessionItemId">): NewRow<"pain_report"> {
  return {
    id: context.env.newId(),
    zone: "knee_right",
    level: "discomfort",
    occurredAt: context.env.now(),
    localDate: "2026-10-20" as LocalDate,
    timeZone,
    sessionId,
    phase: "during",
    ...anchor,
    checkInId: null,
    note: null,
    deletedAt: null,
  };
}

function painOf(painId: Id): PainReport {
  const row = context.db.select().from(painReport).where(eq(painReport.id, painId)).get();
  if (row === undefined) throw new Error(`Missing pain ${painId}`);
  return row;
}

const run = { sport: "run", startedAt: "2026-10-12T18:00:00+02:00", durationSeconds: 2700, values: { distance: 9200, kind: "easy" }, effort: "moderate", title: "Footing du soir" };

const strength = {
  startedAt: "2026-10-20T18:00:00+02:00",
  durationSeconds: 3600,
  exercises: [
    { exercise: "Squat", newExercise: { measure: "load_reps", equipment: "barbell" }, sets: [{ loadGrams: 80000, reps: 8 }, { loadGrams: 80000, reps: 8 }] },
    { exercise: "Gainage", newExercise: { measure: "duration", equipment: "bodyweight" }, sets: [{ durationSeconds: 60 }] },
  ],
};

function openStrengthSession(): Id {
  const id = context.env.newId();
  commit(context.db, context.env, {
    actor: user,
    summary: "Séance",
    revertsId: null,
    mutations: [
      {
        kind: "insert",
        table: "session",
        row: {
          id,
          sport: "strength",
          slotId: null,
          variantId: null,
          countsInRotation: false,
          gearId: null,
          title: null,
          status: "in_progress",
          startedAt: context.env.now(),
          endedAt: null,
          pausedSeconds: 0,
          localDate: "2026-10-24" as LocalDate,
          timeZone,
          values: {},
          effort: null,
          sensation: null,
          enjoyment: null,
          note: null,
          review: "pending",
          deletedAt: null,
        },
      },
    ],
  });
  return id;
}

describe("permission", () => {
  it("refuses every edit tool without the write permission", () => {
    const { sessionId } = ok<{ sessionId: Id }>("log_activity", run);
    context.db.update(settings).set({ agentCanWrite: false }).run();
    const before = context.db.select().from(agentCall).all().length;
    const attempts: readonly [string, unknown][] = [
      ["update_session", { sessionId, note: "Jambes lourdes" }],
      ["update_strength_session", { sessionId, exercises: strength.exercises }],
      ["delete_session", { sessionId }],
      ["update_exercise", { exercise: "Squat", name: "Squat barre" }],
      ["merge_exercises", { duplicate: "Squat", target: "Gainage" }],
      ["set_program_status", { programId: "nope", status: "active" }],
    ];
    for (const [tool, args] of attempts) expect(failed(tool, args)).toContain("Modifier directement");
    expect(sessionRow(sessionId)).toMatchObject({ note: null, deletedAt: null });
    expect(context.db.select().from(agentCall).all()).toHaveLength(before);
  });
});

describe("update_session", () => {
  it("corrects timing, values and feelings, then is undone", () => {
    const { sessionId } = ok<{ sessionId: Id }>("log_activity", run);
    const original = sessionRow(sessionId);
    const result = ok<{ localDate: string; changed: string[] }>("update_session", {
      sessionId,
      startedAt: "2026-10-11T07:30:00+02:00",
      values: { distance: 10_400, kind: "easy" },
      effort: null,
      enjoyment: 4,
      title: null,
    });
    expect(result).toMatchObject({ localDate: "2026-10-11" });
    expect(result.changed.sort()).toEqual(["effort", "endedAt", "enjoyment", "localDate", "startedAt", "title", "values"]);
    expect(sessionRow(sessionId)).toMatchObject({
      startedAt: Date.parse("2026-10-11T05:30:00Z"),
      endedAt: Date.parse("2026-10-11T05:30:00Z") + 2700 * 1000,
      localDate: "2026-10-11",
      values: { distance: 10_400, kind: "easy" },
      effort: null,
      enjoyment: 4,
      title: null,
    });
    const last = lastCall();
    expect(last.summary).toBe("Séance corrigée · Course du 11 octobre");
    expect(context.db.select().from(changeset).where(eq(changeset.id, last.changesetId)).get()).toMatchObject({ author: "agent", connectionId });

    undoLast();
    expect(sessionRow(sessionId)).toMatchObject({ startedAt: original.startedAt, endedAt: original.endedAt, localDate: original.localDate, values: original.values, effort: "moderate", title: "Footing du soir" });
  });

  it("keeps the active duration and pauses when only the start moves", () => {
    const { sessionId } = ok<{ sessionId: Id }>("log_activity", run);
    commit(context.db, context.env, { actor: user, summary: "Pause", revertsId: null, mutations: [{ kind: "update", table: "session", key: sessionId, patch: { pausedSeconds: 300, endedAt: (sessionRow(sessionId).startedAt + 3000 * 1000) as EpochMs } }] });
    ok("update_session", { sessionId, startedAt: "2026-10-12T17:00:00+02:00" });
    const row = sessionRow(sessionId);
    expect(row.endedAt).toBe(Date.parse("2026-10-12T15:00:00Z") + 3000 * 1000);
    ok("update_session", { sessionId, durationSeconds: 3600 });
    expect(sessionRow(sessionId).endedAt).toBe(Date.parse("2026-10-12T15:00:00Z") + 3900 * 1000);
  });

  it("validates the correction before writing anything", () => {
    const { sessionId } = ok<{ sessionId: Id }>("log_activity", run);
    const strengthId = ok<{ sessionId: Id }>("log_strength_session", strength).sessionId;
    const writes = context.db.select().from(changeset).all().length;
    expect(failed("update_session", { sessionId, values: { distance: 9200, kind: "sprint" } })).toContain("kind");
    expect(failed("update_session", { sessionId, items: [{ grade: "french:6a" }] })).toContain("no items");
    expect(failed("update_session", { sessionId, startedAt: "2026-10-24T15:30:00+02:00" })).toContain("future");
    expect(failed("update_session", { sessionId, effort: "moderate", title: "Footing du soir" })).toContain("Nothing to change");
    expect(failed("update_session", { sessionId: strengthId, values: {} })).toContain("update_strength_session");
    expect(failed("update_session", { sessionId: "missing", note: "x" })).toContain("get_history");
    expect(failed("update_session", { sessionId, enjoyment: 7 })).toContain("Invalid input");
    expect(failed("update_session", { sessionId: openStrengthSession(), note: "x" })).toContain("still in progress");
    expect(context.db.select().from(changeset).all()).toHaveLength(writes + 1);
    expect(sessionRow(sessionId).values).toEqual(run.values);
  });

  it("replaces climbing items, keeps pain anchored by position and is undone", () => {
    const { sessionId } = ok<{ sessionId: Id }>("log_activity", {
      sport: "climb",
      startedAt: "2026-10-03T18:00:00+02:00",
      durationSeconds: 5400,
      values: { discipline: "boulder" },
      items: [
        { grade: "fontainebleau:6B+", attempts: 3, result: "sent" },
        { grade: "fontainebleau:6C", attempts: 5, result: "project" },
      ],
    });
    const items = (): { id: Id; values: unknown; recordedAt: number }[] =>
      context.db.select({ id: sessionItem.id, values: sessionItem.values, recordedAt: sessionItem.recordedAt }).from(sessionItem).where(eq(sessionItem.sessionId, sessionId)).orderBy(asc(sessionItem.position)).all();
    const before = items();
    const second = before[1];
    if (second === undefined) throw new Error("Missing item");
    const pain = painRow(sessionId, { strengthSetId: null, sessionItemId: second.id });
    commit(context.db, context.env, { actor: user, summary: "Douleur", revertsId: null, mutations: [{ kind: "insert", table: "pain_report", row: pain }] });

    ok("update_session", {
      sessionId,
      items: [
        { grade: "fontainebleau:6B+", attempts: 2, result: "sent" },
        { grade: "fontainebleau:6C", attempts: 6, result: "sent" },
        { grade: "fontainebleau:7A", attempts: 1, result: "project" },
      ],
    });
    const after = items();
    expect(after.map((item) => item.values)).toEqual([
      { grade: "fontainebleau:6B+", attempts: 2, result: "sent" },
      { grade: "fontainebleau:6C", attempts: 6, result: "sent" },
      { grade: "fontainebleau:7A", attempts: 1, result: "project" },
    ]);
    expect(after.slice(0, 2).map((item) => item.recordedAt)).toEqual(before.map((item) => item.recordedAt));
    expect(painOf(pain.id).sessionItemId).toBe(after[1]?.id);
    expect(lastCall().summary).toBe("Séance corrigée · Escalade du 3 octobre");

    expect(failed("update_session", { sessionId, items: [{ grade: "french:6a", attempts: 1, result: "sent" }] })).toContain("grade");

    undoLast();
    expect(items()).toEqual(before);
    expect(painOf(pain.id).sessionItemId).toBe(second.id);
  });
});

interface HistorySession {
  readonly id: Id;
  readonly exercises: readonly { readonly exercise: string; readonly status: string; readonly sets: readonly { readonly loadGrams: number | null; readonly reps: number | null; readonly durationSeconds: number | null }[] }[];
}

function history(): readonly HistorySession[] {
  return ok<{ sessions: HistorySession[] }>("get_history", { from: "2026-10-01", to: "2026-10-24" }).sessions;
}

describe("update_strength_session", () => {
  it("replaces the exercise list, keeping program links, set times and pain anchors of the exercises that stay", () => {
    const { sessionId } = ok<{ sessionId: Id }>("log_strength_session", strength);
    const programmed = ok<{ programId: Id }>("upsert_program", {
      name: "Base",
      sessionsPerWeek: 2,
      summary: "Programme",
      slots: [{ name: "Séance A", sport: "strength", variants: [{ name: "Salle", items: [{ exercise: "Squat", sets: 3, repsMin: 6, repsMax: 8 }] }] }],
    });
    expect(programmed.programId).toBeDefined();
    const item = context.db.select().from(programItem).get();
    const squatEntry = context.db.select().from(strengthEntry).where(eq(strengthEntry.position, 0)).get();
    if (item === undefined || squatEntry === undefined) throw new Error("Missing rows");
    const firstSet = context.db.select().from(strengthSet).where(eq(strengthSet.entryId, squatEntry.id)).orderBy(asc(strengthSet.position)).get();
    if (firstSet === undefined) throw new Error("Missing set");
    const pain = painRow(sessionId, { strengthSetId: firstSet.id, sessionItemId: null });
    commit(context.db, context.env, {
      actor: user,
      summary: "Lien et douleur",
      revertsId: null,
      mutations: [
        { kind: "update", table: "strength_entry", key: squatEntry.id, patch: { programItemId: item.id, status: "stopped" } },
        { kind: "insert", table: "pain_report", row: pain },
      ],
    });
    const before = history();

    ok("update_strength_session", {
      sessionId,
      exercises: [
        { exercise: "Rowing haltère", newExercise: { measure: "load_reps", equipment: "dumbbell" }, sets: [{ loadGrams: 24000, reps: 10 }] },
        { exercise: "squat", note: "Genou droit sensible", sets: [{ loadGrams: 82500, reps: 8 }, { loadGrams: 82500, reps: 7 }, { loadGrams: 80000, reps: 8 }] },
      ],
    });
    expect(lastCall().summary).toBe("Séance corrigée · Musculation du 20 octobre · 2 exercices");
    expect(history()[0]?.exercises).toEqual([
      expect.objectContaining({ exercise: "Rowing haltère", status: "done", sets: [expect.objectContaining({ loadGrams: 24000, reps: 10 })] }),
      expect.objectContaining({ exercise: "Squat", status: "stopped", note: "Genou droit sensible", sets: [expect.objectContaining({ loadGrams: 82500, reps: 8 }), expect.objectContaining({ reps: 7 }), expect.objectContaining({ loadGrams: 80000 })] }),
    ]);
    const squat = context.db.select().from(strengthEntry).where(eq(strengthEntry.position, 1)).get();
    expect(squat?.programItemId).toBe(item.id);
    const newFirst = context.db.select().from(strengthSet).where(eq(strengthSet.entryId, squat?.id ?? ("" as Id))).orderBy(asc(strengthSet.position)).get();
    expect(newFirst?.completedAt).toBe(firstSet.completedAt);
    expect(painOf(pain.id).strengthSetId).toBe(newFirst?.id);
    expect(context.db.select().from(changeset).where(eq(changeset.summary, "Exercice ajouté · Rowing haltère")).get()?.author).toBe("agent");

    undoLast();
    expect(history()).toEqual(before);
    expect(painOf(pain.id).strengthSetId).toBe(firstSet.id);
  });

  it("refuses other sports, wrong sets and open sessions", () => {
    const { sessionId } = ok<{ sessionId: Id }>("log_strength_session", strength);
    const runId = ok<{ sessionId: Id }>("log_activity", run).sessionId;
    const openId = openStrengthSession();
    const before = history();
    expect(failed("update_strength_session", { sessionId: runId, exercises: strength.exercises })).toContain("update_session");
    expect(failed("update_strength_session", { sessionId, exercises: [{ exercise: "Gainage", sets: [{ reps: 10 }] }] })).toContain("durationSeconds");
    expect(failed("update_strength_session", { sessionId, exercises: [] })).toContain("Invalid input");
    expect(failed("update_strength_session", { sessionId: openId, exercises: strength.exercises })).toContain("finish it there");
    expect(history()).toEqual(before);
  });
});

describe("delete_session", () => {
  it("moves the session to the trash and is undone", () => {
    const { sessionId } = ok<{ sessionId: Id }>("log_activity", run);
    const result = ok<{ restorableUntil: string }>("delete_session", { sessionId });
    expect(result.restorableUntil).toBe(new Date(context.env.now() + 30 * 86_400_000).toISOString());
    expect(sessionRow(sessionId).deletedAt).toBe(context.env.now());
    expect(trashItems(context.db).map((item) => item.row.id)).toEqual([sessionId]);
    expect(history()).toEqual([]);
    expect(lastCall().summary).toBe("Séance supprimée · Course du 12 octobre");
    expect(failed("delete_session", { sessionId })).toContain("trash");
    expect(failed("update_session", { sessionId, note: "x" })).toContain("trash");

    undoLast();
    expect(sessionRow(sessionId).deletedAt).toBeNull();
    expect(history().map((row) => row.id)).toEqual([sessionId]);
  });

  it("refuses open sessions", () => {
    const openId = openStrengthSession();
    expect(failed("delete_session", { sessionId: openId })).toContain("before deleting it");
    expect(sessionRow(openId).deletedAt).toBeNull();
  });
});

interface ExerciseData {
  readonly exerciseId: Id;
  readonly name: string;
  readonly measure: string;
  readonly loadMode: string;
  readonly baseGrams: number | null;
  readonly loadStepGrams: number | null;
  readonly zones: readonly string[];
  readonly archived: boolean;
}

describe("update_exercise", () => {
  it("renames, re-equips and re-zones an exercise, then is undone", () => {
    ok("create_exercise", { name: "Rowing haltère", measure: "load_reps", equipment: "dumbbell", loadStepGrams: 1000, zones: ["lower_back"] });
    const updated = ok<ExerciseData>("update_exercise", { exercise: "rowing haltere", name: "Rowing  unilatéral", equipment: "cable", loadStepGrams: 2500, zones: ["shoulder_right", "lower_back"] });
    expect(updated).toMatchObject({ name: "Rowing unilatéral", loadStepGrams: 2500, archived: false });
    expect([...updated.zones].sort()).toEqual(["lower_back", "shoulder_right"]);
    expect(lastCall().summary).toBe("Exercice modifié · Rowing unilatéral");

    undoLast();
    const row = context.db.select().from(exercise).where(eq(exercise.id, updated.exerciseId)).get();
    expect(row).toMatchObject({ name: "Rowing haltère", equipment: "dumbbell", loadStepGrams: 1000 });
    expect(context.db.select({ zone: exerciseZone.zone }).from(exerciseZone).all()).toEqual([{ zone: "lower_back" }]);
  });

  it("keeps zones unreviewed when they are not sent", () => {
    ok("log_strength_session", strength);
    ok("update_exercise", { exercise: "Squat", equipment: "machine" });
    expect(context.db.select().from(exercise).where(eq(exercise.name, "Squat")).get()).toMatchObject({ equipment: "machine", zonesReviewed: false });
  });

  it("archives and restores", () => {
    ok("create_exercise", { name: "Dips", measure: "bodyweight_reps", equipment: "bodyweight" });
    expect(ok<ExerciseData>("update_exercise", { exercise: "Dips", archived: true }).archived).toBe(true);
    expect(lastCall().summary).toBe("Exercice archivé · Dips");
    expect(failed("update_exercise", { exercise: "Dips", archived: true })).toContain("Nothing to change");
    expect(ok<ExerciseData>("update_exercise", { exercise: "Dips", archived: false }).archived).toBe(false);
    expect(lastCall().summary).toBe("Exercice restauré · Dips");
  });

  it("protects name uniqueness and the measure of used exercises", () => {
    ok("log_strength_session", strength);
    ok("create_exercise", { name: "Pompes", measure: "bodyweight_reps", equipment: "bodyweight" });
    expect(failed("update_exercise", { exercise: "Pompes", name: "SQUAT" })).toContain("merge_exercises");
    expect(failed("update_exercise", { exercise: "Squat", measure: "duration" })).toContain("measure cannot change");
    expect(failed("update_exercise", { exercise: "Gainage", loadStepGrams: 1000 })).toContain("not allowed for duration");
    expect(failed("update_exercise", { exercise: "Inconnu", name: "X" })).toContain("list_exercises");
    expect(failed("update_exercise", { exercise: "Pompes", equipment: "bodyweight" })).toContain("Nothing to change");
    const changed = ok<ExerciseData>("update_exercise", { exercise: "Pompes", measure: "load_reps", loadStepGrams: 1250 });
    expect(changed).toMatchObject({ measure: "load_reps", loadStepGrams: 1250 });
    expect(ok<ExerciseData>("update_exercise", { exercise: "Pompes", measure: "duration" })).toMatchObject({ measure: "duration", loadStepGrams: null });
  });

  it("relabels the load mode, clears the base weight outside per_side and keeps duration exercises total", () => {
    ok("create_exercise", { name: "Gainage", measure: "duration", equipment: "bodyweight" });
    ok("create_exercise", { name: "Curl barre EZ", measure: "load_reps", equipment: "barbell" });
    expect(ok<ExerciseData>("update_exercise", { exercise: "Curl barre EZ", loadMode: "per_side", baseGrams: 10_000 })).toMatchObject({ loadMode: "per_side", baseGrams: 10_000 });
    expect(ok<ExerciseData>("update_exercise", { exercise: "Curl barre EZ", equipment: "other" })).toMatchObject({ loadMode: "per_side", baseGrams: 10_000 });
    expect(ok<ExerciseData>("update_exercise", { exercise: "Curl barre EZ", loadMode: "total" })).toMatchObject({ loadMode: "total", baseGrams: null });
    expect(failed("update_exercise", { exercise: "Curl barre EZ", baseGrams: 10_000 })).toContain("only allowed with loadMode per_side");
    expect(failed("update_exercise", { exercise: "Gainage", loadMode: "per_hand" })).toContain("always loadMode total");
    undoLast();
    expect(context.db.select().from(exercise).where(eq(exercise.name, "Curl barre EZ")).get()).toMatchObject({ loadMode: "per_side", baseGrams: 10_000 });
  });
});

describe("merge_exercises", () => {
  it("folds a duplicate into the target, keeps immutable program versions and is undone", () => {
    ok("create_exercise", { name: "Développé couché", measure: "load_reps", equipment: "barbell", zones: ["shoulder_right"] });
    ok("create_exercise", { name: "Dev couché barre", measure: "load_reps", equipment: "barbell", zones: ["elbow_left", "shoulder_right"] });
    ok("log_strength_session", { ...strength, exercises: [{ exercise: "Dev couché barre", sets: [{ loadGrams: 70000, reps: 6 }] }] });
    const created = ok<{ programId: Id }>("upsert_program", {
      name: "Base",
      sessionsPerWeek: 2,
      summary: "Programme",
      slots: [{ name: "Séance A", sport: "strength", variants: [{ name: "Salle", items: [{ exercise: "Dev couché barre", sets: 3, repsMin: 6, repsMax: 8 }] }] }],
    });
    const ids = Object.fromEntries(context.db.select().from(exercise).all().map((row) => [row.name, row.id]));
    const target = ids["Développé couché"] as Id;
    const duplicate = ids["Dev couché barre"] as Id;

    expect(ok<{ movedEntries: number }>("merge_exercises", { duplicate: "Dev couché barre", target: "développé couché" }).movedEntries).toBe(1);
    expect(lastCall().summary).toBe("Exercices fusionnés · Dev couché barre dans Développé couché");
    expect(context.db.select().from(exercise).where(eq(exercise.id, duplicate)).get()).toMatchObject({ mergedIntoId: target, archivedAt: context.env.now() });
    expect(context.db.select().from(strengthEntry).all().map((row) => row.exerciseId)).toEqual([target]);
    expect(context.db.select().from(programItem).all().map((row) => row.exerciseId)).toEqual([duplicate]);
    const zonesOfTarget = context.db.select({ zone: exerciseZone.zone }).from(exerciseZone).where(eq(exerciseZone.exerciseId, target)).all().map((row) => row.zone);
    expect(zonesOfTarget.sort()).toEqual(["elbow_left", "shoulder_right"]);
    expect(ok<{ exercise: { id: Id } }>("get_exercise_progress", { exercise: "Dev couché barre" }).exercise.id).toBe(target);
    expect(ok<{ exercises: { name: string }[] }>("list_exercises", {}).exercises.map((row) => row.name)).toEqual(["Développé couché"]);

    const tree = ok<{ latest: { slots: { lineageId: string; variants: { lineageId: string; items: { lineageId: string; exercise: string }[] }[] }[] } }>("get_program", { programId: created.programId });
    const slot = tree.latest.slots[0];
    const variant = slot?.variants[0];
    const kept = variant?.items[0];
    expect(kept?.exercise).toBe("Dev couché barre");
    ok("upsert_program", {
      programId: created.programId,
      name: "Base",
      sessionsPerWeek: 2,
      summary: "Exercice fusionné",
      slots: [{ lineageId: slot?.lineageId, name: "Séance A", sport: "strength", variants: [{ lineageId: variant?.lineageId, name: "Salle", items: [{ lineageId: kept?.lineageId, exercise: kept?.exercise, sets: 3, repsMin: 6, repsMax: 8 }] }] }],
    });
    expect(context.db.select().from(exercise).all()).toHaveLength(2);
    expect(context.db.select().from(programItem).all().map((row) => row.exerciseId)).toEqual([duplicate, target]);

    const merge = context.db.select().from(agentCall).where(eq(agentCall.tool, "merge_exercises")).get();
    if (merge?.changesetId == null) throw new Error("Missing merge");
    toggleChange(context.db, context.env, user, merge.changesetId, merge.summary);
    expect(context.db.select().from(exercise).where(eq(exercise.id, duplicate)).get()).toMatchObject({ mergedIntoId: null, archivedAt: null });
    expect(context.db.select().from(strengthEntry).all().map((row) => row.exerciseId)).toEqual([duplicate]);
    expect(context.db.select().from(exerciseZone).where(eq(exerciseZone.exerciseId, target)).all()).toHaveLength(1);
  });

  it("refuses incompatible merges", () => {
    ok("log_strength_session", strength);
    ok("create_exercise", { name: "Squat avant", measure: "load_reps", equipment: "barbell" });
    expect(failed("merge_exercises", { duplicate: "Gainage", target: "Squat" })).toContain("measured differently");
    expect(failed("merge_exercises", { duplicate: "Squat", target: "squat" })).toContain("same exercise");
    ok("update_exercise", { exercise: "Squat", archived: true });
    expect(failed("merge_exercises", { duplicate: "Squat avant", target: "Squat" })).toContain("archived");
    ok("update_exercise", { exercise: "Squat", archived: false });
    ok("merge_exercises", { duplicate: "Squat avant", target: "Squat" });
    expect(failed("merge_exercises", { duplicate: "Squat avant", target: "Squat" })).toContain("same exercise");
  });
});

describe("set_program_status", () => {
  const draft = (name: string): unknown => ({ name, sessionsPerWeek: 2, summary: name, slots: [{ name: "Footing", sport: "run", variants: [] }] });
  const statuses = (): Record<string, string> => Object.fromEntries(context.db.select().from(program).all().map((row) => [row.id, row.status]));

  it("activates one program at a time, archives, and is undone", () => {
    const first = ok<{ programId: Id }>("upsert_program", draft("Hiver")).programId;
    const second = ok<{ programId: Id }>("upsert_program", draft("Printemps")).programId;
    ok("set_program_status", { programId: first, status: "active" });
    expect(lastCall().summary).toBe("Programme activé · Hiver");
    expect(failed("set_program_status", { programId: first, status: "active" })).toContain("already the active program");

    expect(ok<{ archivedProgramId: Id | null }>("set_program_status", { programId: second, status: "active" }).archivedProgramId).toBe(first);
    expect(lastCall().summary).toBe("Programme activé · Printemps, Hiver archivé");
    expect(statuses()).toEqual({ [first]: "archived", [second]: "active" });

    undoLast();
    expect(statuses()).toEqual({ [first]: "active", [second]: "draft" });

    ok("set_program_status", { programId: first, status: "archived" });
    expect(lastCall().summary).toBe("Programme archivé · Hiver");
    expect(failed("set_program_status", { programId: first, status: "archived" })).toContain("already archived");
    ok("set_program_status", { programId: first, status: "active" });
    expect(statuses()).toEqual({ [first]: "active", [second]: "draft" });
  });

  it("refuses unknown programs and draft status", () => {
    expect(failed("set_program_status", { programId: "nope", status: "active" })).toContain("list_programs");
    const first = ok<{ programId: Id }>("upsert_program", draft("Hiver")).programId;
    expect(failed("set_program_status", { programId: first, status: "draft" })).toContain("Invalid input");
  });
});
