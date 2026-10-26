import { eq } from "drizzle-orm";
import { exercise } from "@obnixe/schema";
import type { Id } from "@obnixe/schema";
import type { ObnixeDatabase } from "../database.ts";
import type { Mutation } from "../writer.ts";
import { SessionStateError } from "./lifecycle.ts";
import { findExercise } from "./workout.ts";
import type { WorkoutData } from "./workout.ts";

const temporaryOffset = 1_000_000;

export class ExerciseNotFoundError extends Error {
  constructor(readonly exerciseId: Id) {
    super(`Exercise ${exerciseId} does not exist`);
  }
}

interface Placement {
  readonly id: Id;
  readonly position: number;
}

function movedPlacements(data: WorkoutData, orderedEntryIds: readonly Id[]): Placement[] {
  const current = data.exercises.map((candidate) => candidate.entry);
  if (orderedEntryIds.length !== current.length || current.some((entry) => !orderedEntryIds.includes(entry.id))) {
    throw new Error("Reordering must list every entry of the session exactly once");
  }
  return orderedEntryIds.flatMap((id, position) => {
    const entry = current.find((candidate) => candidate.id === id);
    return entry === undefined || entry.position === position ? [] : [{ id, position }];
  });
}

function placementMutations(moved: readonly Placement[]): Mutation[] {
  return [
    ...moved.map(({ id }, index): Mutation => ({ kind: "update", table: "strength_entry", key: id, patch: { position: temporaryOffset + index } })),
    ...moved.map(({ id, position }): Mutation => ({ kind: "update", table: "strength_entry", key: id, patch: { position } })),
  ];
}

export function reorderMutations(data: WorkoutData, orderedEntryIds: readonly Id[]): Mutation[] {
  return placementMutations(movedPlacements(data, orderedEntryIds));
}

function isPending(data: WorkoutData, id: Id): boolean {
  return data.exercises.find((candidate) => candidate.entry.id === id)?.entry.status === "pending";
}

function orderWithout(data: WorkoutData, entryId: Id): Id[] {
  findExercise(data, entryId);
  return data.exercises.map((candidate) => candidate.entry.id).filter((id) => id !== entryId);
}

export function postponeEntryMutations(data: WorkoutData, entryId: Id): Mutation[] {
  const rest = orderWithout(data, entryId);
  const lastPending = rest.reduce((last, id, index) => (isPending(data, id) ? index : last), -1);
  rest.splice(lastPending + 1, 0, entryId);
  return reorderMutations(data, rest);
}

export function bringForwardMutations(data: WorkoutData, entryId: Id): Mutation[] {
  const rest = orderWithout(data, entryId);
  const firstPending = rest.findIndex((id) => isPending(data, id));
  rest.splice(firstPending === -1 ? rest.length : firstPending, 0, entryId);
  return reorderMutations(data, rest);
}

export function addExerciseMutations(db: ObnixeDatabase, data: WorkoutData, exerciseId: Id, newEntryId: Id): Mutation[] {
  if (data.session.status === "completed") throw new SessionStateError(data.session.id, "open");
  const found = db.select({ id: exercise.id, mergedIntoId: exercise.mergedIntoId }).from(exercise).where(eq(exercise.id, exerciseId)).get();
  if (found === undefined) throw new ExerciseNotFoundError(exerciseId);
  const position = data.exercises.reduce((max, candidate) => Math.max(max, candidate.entry.position + 1), 0);
  return [
    {
      kind: "insert",
      table: "strength_entry",
      row: { id: newEntryId, sessionId: data.session.id, position, exerciseId: found.mergedIntoId ?? found.id, programItemId: null, status: "pending", note: null },
    },
  ];
}

export function replaceExerciseMutations(data: WorkoutData, entryId: Id, exerciseId: Id, newEntryId: Id): Mutation[] {
  const target = findExercise(data, entryId);
  if (target.sets.length === 0) return [{ kind: "update", table: "strength_entry", key: entryId, patch: { exerciseId, status: "pending" } }];
  const ids = data.exercises.map((candidate) => candidate.entry.id);
  const index = ids.indexOf(entryId);
  const shifted = ids.flatMap((id, position): Placement[] => {
    const finalPosition = position > index ? position + 1 : position;
    const entry = data.exercises[position]?.entry;
    return entry === undefined || entry.position === finalPosition ? [] : [{ id, position: finalPosition }];
  });
  return [
    ...(target.entry.status === "pending" ? [{ kind: "update", table: "strength_entry", key: entryId, patch: { status: "stopped" } } satisfies Mutation] : []),
    ...placementMutations(shifted),
    {
      kind: "insert",
      table: "strength_entry",
      row: { id: newEntryId, sessionId: data.session.id, position: index + 1, exerciseId, programItemId: target.entry.programItemId, status: "pending", note: null },
    },
  ];
}
