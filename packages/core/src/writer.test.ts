import { asc, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { change, exercise, exerciseNameKey, exerciseZone, programItem, programSlot, programVariant, programVersion, session, strengthEntry } from "@obnixe/schema";
import type { Id, LocalDate } from "@obnixe/schema";
import { createTestContext } from "./testing.ts";
import type { TestContext } from "./testing.ts";
import { AlreadyRevertedError, RevertConflictError, revert } from "./undo.ts";
import { DependentRowsError, EmptyChangesetError, commit } from "./writer.ts";
import type { Actor, Mutation, NewRow } from "./writer.ts";

const user: Actor = { author: "user", connectionId: null };

let context: TestContext;

beforeEach(() => {
  context = createTestContext();
});

function write(summary: string, mutations: readonly Mutation[]): Id {
  return commit(context.db, context.env, { actor: user, summary, revertsId: null, mutations });
}

function undo(changesetId: Id): Id {
  return revert(context.db, context.env, { actor: user, changesetId, summary: "Annulation", restoredVersionSummary: (number) => `Retour à la v${number}` });
}

function newExercise(name: string): NewRow<"exercise"> {
  return { id: context.env.newId(), name, nameKey: exerciseNameKey(name), measure: "load_reps", equipment: "barbell", loadMode: "total", baseGrams: null, loadStepGrams: 2500, zonesReviewed: true, mergedIntoId: null, archivedAt: null };
}

function newSession(overrides: Partial<NewRow<"session">> = {}): NewRow<"session"> {
  return {
    id: context.env.newId(),
    sport: "strength",
    slotId: null,
    variantId: null,
    countsInRotation: false,
    gearId: null,
    title: null,
    status: "completed",
    startedAt: context.env.now(),
    endedAt: context.env.now(),
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
    ...overrides,
  };
}

function newProgramVersion(programId: Id, number: number, sets: number, exerciseId: Id): Mutation[] {
  const versionId = context.env.newId();
  const slotId = context.env.newId();
  const variantId = context.env.newId();
  return [
    { kind: "insert", table: "program_version", row: { id: versionId, programId, number, name: "Base hiver", sessionsPerWeek: 4, copiedFromId: null, summary: null, reason: null } },
    { kind: "insert", table: "program_slot", row: { id: slotId, versionId, lineageId: "slot-a" as Id, position: 0, sport: "strength", name: "Séance A", targetDurationSeconds: null, targetEffort: null, targetValues: {} } },
    { kind: "insert", table: "program_variant", row: { id: variantId, slotId, lineageId: "gym" as Id, position: 0, name: "Salle" } },
    { kind: "insert", table: "program_item", row: { id: context.env.newId(), variantId, lineageId: "squat" as Id, position: 0, exerciseId, sets, repsMin: 6, repsMax: 8, durationMinSeconds: null, durationMaxSeconds: null, targetRir: 2, restSeconds: 150, restAfterSeconds: null } },
  ];
}

function itemSets(versionId: Id): { sets: number; lineageId: Id }[] {
  return context.db
    .select({ sets: programItem.sets, lineageId: programItem.lineageId })
    .from(programItem)
    .innerJoin(programVariant, eq(programItem.variantId, programVariant.id))
    .innerJoin(programSlot, eq(programVariant.slotId, programSlot.id))
    .where(eq(programSlot.versionId, versionId))
    .all();
}

describe("commit", () => {
  it("journals every row with managed timestamps", () => {
    const bench = newExercise("Développé couché");
    const id = write("Ajout", [{ kind: "insert", table: "exercise", row: bench }]);
    const stored = context.db.select().from(exercise).where(eq(exercise.id, bench.id)).get();
    expect(stored?.createdAt).toBe(context.env.now());
    const [entry] = context.db.select().from(change).where(eq(change.changesetId, id)).all();
    expect(entry).toMatchObject({ tableName: "exercise", rowId: bench.id, operation: "insert", before: null });
    expect(entry?.after).toMatchObject({ name: "Développé couché", nameKey: "developpe couche" });
  });

  it("rejects invalid rows and writes nothing", () => {
    const bad = { ...newSession(), status: "paused" } as unknown as NewRow<"session">;
    expect(() => write("Séance", [{ kind: "insert", table: "exercise", row: newExercise("Squat") }, { kind: "insert", table: "session", row: bad }])).toThrow(ZodError);
    expect(context.db.select().from(exercise).all()).toHaveLength(0);
  });

  it("refuses deletes that would cascade outside the journal", () => {
    const bench = newExercise("Développé couché");
    const workout = newSession();
    write("Séance", [
      { kind: "insert", table: "exercise", row: bench },
      { kind: "insert", table: "session", row: workout },
      { kind: "insert", table: "strength_entry", row: { id: context.env.newId(), sessionId: workout.id, position: 0, exerciseId: bench.id, programItemId: null, status: "done", note: null } },
    ]);
    expect(() => write("Suppression", [{ kind: "delete", table: "session", key: workout.id }])).toThrow(DependentRowsError);
    expect(context.db.select().from(strengthEntry).all()).toHaveLength(1);
  });

  it("rolls back earlier mutations when a database constraint fails", () => {
    const bench = newExercise("Développé couché");
    const workout = newSession();
    const entry = (): Mutation => ({ kind: "insert", table: "strength_entry", row: { id: context.env.newId(), sessionId: workout.id, position: 0, exerciseId: bench.id, programItemId: null, status: "done", note: null } });
    expect(() => write("Séance", [{ kind: "insert", table: "exercise", row: bench }, { kind: "insert", table: "session", row: workout }, entry(), entry()])).toThrow(/UNIQUE/);
    expect(context.db.select().from(exercise).all()).toHaveLength(0);
    expect(context.db.select().from(change).all()).toHaveLength(0);
  });

  it("refuses empty changesets", () => {
    expect(() => write("Rien", [])).toThrow(EmptyChangesetError);
  });
});

describe("sport values", () => {
  const climbItem = (sessionId: Id, position: number, grade: string): Mutation => ({
    kind: "insert",
    table: "session_item",
    row: { id: context.env.newId(), sessionId, position, values: { grade, attempts: 2, result: "sent" }, recordedAt: context.env.now() },
  });

  it("validates item grades against the scale set by the discipline", () => {
    const climb = newSession({ sport: "climb", values: { discipline: "boulder" } });
    write("Bloc", [{ kind: "insert", table: "session", row: climb }, climbItem(climb.id, 0, "fontainebleau:6B")]);
    expect(() => write("Voie", [climbItem(climb.id, 1, "french:6b")])).toThrow(ZodError);
  });

  it("revalidates items when the session discipline changes", () => {
    const climb = newSession({ sport: "climb", values: { discipline: "boulder" } });
    write("Bloc", [{ kind: "insert", table: "session", row: climb }, climbItem(climb.id, 0, "fontainebleau:6B")]);
    expect(() => write("Discipline", [{ kind: "update", table: "session", key: climb.id, patch: { values: { discipline: "lead" } } }])).toThrow(ZodError);
  });

  it("rejects session values the sport does not define", () => {
    expect(() => write("Course", [{ kind: "insert", table: "session", row: newSession({ sport: "run", values: { kind: "sprint" } }) }])).toThrow(ZodError);
    expect(() => write("Course", [{ kind: "insert", table: "session", row: newSession({ sport: "run", values: { cadence: 180 } }) }])).toThrow(ZodError);
  });

  it("accepts partial slot targets but checks them against the sport", () => {
    const programId = context.env.newId();
    const versionId = context.env.newId();
    const slot = (sport: "run" | "climb", targetValues: Record<string, string>): Mutation => ({
      kind: "insert",
      table: "program_slot",
      row: { id: context.env.newId(), versionId, lineageId: context.env.newId(), position: 0, sport, name: "Créneau", targetDurationSeconds: null, targetEffort: null, targetValues },
    });
    write("Programme", [
      { kind: "insert", table: "program", row: { id: programId, status: "draft" } },
      { kind: "insert", table: "program_version", row: { id: versionId, programId, number: 1, name: "Prépa", sessionsPerWeek: 3, copiedFromId: null, summary: null, reason: null } },
      slot("climb", {}),
    ]);
    expect(() => write("Créneau", [slot("run", { kind: "sprint" })])).toThrow(ZodError);
  });
});

describe("revert", () => {
  it("restores the previous state and refuses a second revert", () => {
    const workout = newSession();
    write("Séance", [{ kind: "insert", table: "session", row: workout }]);
    context.advance(1000);
    const edit = write("Note", [{ kind: "update", table: "session", key: workout.id, patch: { note: "Épaule raide" } }]);
    undo(edit);
    expect(context.db.select().from(session).where(eq(session.id, workout.id)).get()?.note).toBeNull();
    expect(() => undo(edit)).toThrow(AlreadyRevertedError);
  });

  it("refuses when a later change touched the same row", () => {
    const workout = newSession();
    const created = write("Séance", [{ kind: "insert", table: "session", row: workout }]);
    context.advance(1000);
    write("Note", [{ kind: "update", table: "session", key: workout.id, patch: { note: "Bien" } }]);
    expect(() => undo(created)).toThrow(RevertConflictError);
  });

  it("redoes a change by reverting its revert", () => {
    const workout = newSession();
    write("Séance", [{ kind: "insert", table: "session", row: workout }]);
    const edit = write("Note", [{ kind: "update", table: "session", key: workout.id, patch: { note: "Épaule raide" } }]);
    const undone = undo(edit);
    undo(undone);
    expect(context.db.select().from(session).where(eq(session.id, workout.id)).get()?.note).toBe("Épaule raide");
  });

  it("undoes a changeset that touched the same row twice", () => {
    const workout = newSession({ note: "Avant" });
    write("Séance", [{ kind: "insert", table: "session", row: workout }]);
    const edits = write("Notes", [
      { kind: "update", table: "session", key: workout.id, patch: { note: "Pendant" } },
      { kind: "update", table: "session", key: workout.id, patch: { note: "Après" } },
    ]);
    undo(edits);
    expect(context.db.select().from(session).where(eq(session.id, workout.id)).get()?.note).toBe("Avant");
  });

  it("restores a deleted row with its original creation time and composite key", () => {
    const bench = newExercise("Développé couché");
    write("Exercice", [{ kind: "insert", table: "exercise", row: bench }, { kind: "insert", table: "exercise_zone", row: { exerciseId: bench.id, zone: "shoulder_right" } }]);
    const createdAt = context.env.now();
    context.advance(5000);
    const removed = write("Suppression", [
      { kind: "delete", table: "exercise_zone", key: `${bench.id}|shoulder_right` },
      { kind: "delete", table: "exercise", key: bench.id },
    ]);
    expect(context.db.select().from(exerciseZone).all()).toHaveLength(0);
    context.advance(5000);
    undo(removed);
    expect(context.db.select().from(exerciseZone).all()).toEqual([{ exerciseId: bench.id, zone: "shoulder_right" }]);
    expect(context.db.select().from(exercise).get()).toMatchObject({ id: bench.id, createdAt, updatedAt: context.env.now() });
  });

  it("reports rows that now depend on a reverted insert as a conflict", () => {
    const bench = newExercise("Développé couché");
    const created = write("Exercice", [{ kind: "insert", table: "exercise", row: bench }]);
    const workout = newSession();
    write("Séance", [
      { kind: "insert", table: "session", row: workout },
      { kind: "insert", table: "strength_entry", row: { id: context.env.newId(), sessionId: workout.id, position: 0, exerciseId: bench.id, programItemId: null, status: "done", note: null } },
    ]);
    expect(() => undo(created)).toThrow(RevertConflictError);
    expect(context.db.select().from(exercise).all()).toHaveLength(1);
  });

  it("reverts a program version by publishing the previous content as a new version", () => {
    const programId = context.env.newId();
    const squat = newExercise("Squat barre");
    const created = write("Programme", [{ kind: "insert", table: "exercise", row: squat }, { kind: "insert", table: "program", row: { id: programId, status: "active" } }, ...newProgramVersion(programId, 1, 3, squat.id)]);
    context.advance(1000);
    const edited = write("v2", newProgramVersion(programId, 2, 4, squat.id));
    const reverted = undo(edited);
    const versions = context.db.select().from(programVersion).orderBy(asc(programVersion.number)).all();
    expect(versions.map((row) => [row.number, row.summary, row.copiedFromId])).toEqual([[1, null, null], [2, null, null], [3, "Retour à la v1", versions[0]?.id]]);
    expect(itemSets(versions[2]?.id ?? ("" as Id))).toEqual([{ sets: 3, lineageId: "squat" }]);
    expect(() => undo(created)).toThrow(RevertConflictError);
    undo(reverted);
    const redone = context.db.select().from(programVersion).orderBy(asc(programVersion.number)).all().at(-1);
    expect(redone?.number).toBe(4);
    expect(itemSets(redone?.id ?? ("" as Id))).toEqual([{ sets: 4, lineageId: "squat" }]);
  });

  it("refuses to revert a program version that is no longer the latest", () => {
    const programId = context.env.newId();
    const squat = newExercise("Squat barre");
    write("Programme", [{ kind: "insert", table: "exercise", row: squat }, { kind: "insert", table: "program", row: { id: programId, status: "active" } }, ...newProgramVersion(programId, 1, 3, squat.id)]);
    const second = write("v2", newProgramVersion(programId, 2, 4, squat.id));
    write("v3", newProgramVersion(programId, 3, 5, squat.id));
    expect(() => undo(second)).toThrow(RevertConflictError);
    expect(context.db.select().from(programVersion).all()).toHaveLength(3);
  });

  it("reverts the creation of a program by removing its whole tree", () => {
    const programId = context.env.newId();
    const versionId = context.env.newId();
    const slotId = context.env.newId();
    const created = write("Programme", [
      { kind: "insert", table: "program", row: { id: programId, status: "draft" } },
      { kind: "insert", table: "program_version", row: { id: versionId, programId, number: 1, name: "Prépa", sessionsPerWeek: 3, copiedFromId: null, summary: null, reason: null } },
      { kind: "insert", table: "program_slot", row: { id: slotId, versionId, lineageId: "run" as Id, position: 0, sport: "run", name: "Footing", targetDurationSeconds: 2400, targetEffort: "easy", targetValues: { kind: "easy" } } },
    ]);
    undo(created);
    expect(context.db.select().from(programSlot).all()).toHaveLength(0);
    expect(context.db.select().from(programVersion).all()).toHaveLength(0);
  });
});
