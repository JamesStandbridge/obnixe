import { and, eq, isNull } from "drizzle-orm";
import { exercise, exerciseNameKey } from "@obnixe/schema";
import type { Equipment, Exercise, ExerciseMeasure, Id } from "@obnixe/schema";
import type { Environment, ObnixeDatabase } from "../database.ts";
import type { NewRow } from "../writer.ts";

const maxMergeDepth = 16;

export function findExercise(db: ObnixeDatabase, reference: string): Exercise | undefined {
  let found =
    db.select().from(exercise).where(eq(exercise.id, reference as Id)).get() ??
    db.select().from(exercise).where(and(eq(exercise.nameKey, exerciseNameKey(reference)), isNull(exercise.mergedIntoId))).get();
  for (let depth = 0; found?.mergedIntoId != null && depth < maxMergeDepth; depth += 1) {
    found = db.select().from(exercise).where(eq(exercise.id, found.mergedIntoId)).get();
  }
  return found;
}

export interface ExerciseRequest {
  readonly exercise: string;
  readonly newExercise?: { readonly measure: ExerciseMeasure; readonly equipment: Equipment } | undefined;
}

export interface ResolvedExercise {
  readonly id: Id;
  readonly name: string;
  readonly measure: ExerciseMeasure;
}

export interface ExercisePlan {
  readonly resolved: ReadonlyMap<string, ResolvedExercise>;
  readonly created: readonly NewRow<"exercise">[];
}

export function planExercises(db: ObnixeDatabase, env: Environment, requests: readonly ExerciseRequest[]): ExercisePlan {
  const resolved = new Map<string, ResolvedExercise>();
  const createdByKey = new Map<string, NewRow<"exercise">>();
  for (const request of requests) {
    if (resolved.has(request.exercise)) continue;
    const existing = findExercise(db, request.exercise);
    if (existing !== undefined) {
      resolved.set(request.exercise, { id: existing.id, name: existing.name, measure: existing.measure });
      continue;
    }
    const name = request.exercise.trim().replace(/\s+/g, " ");
    const nameKey = exerciseNameKey(name);
    const pending = createdByKey.get(nameKey) ?? newExerciseRow(env, name, request.newExercise?.measure ?? "load_reps", request.newExercise?.equipment ?? "other");
    createdByKey.set(nameKey, pending);
    resolved.set(request.exercise, { id: pending.id, name: pending.name, measure: pending.measure });
  }
  return { resolved, created: [...createdByKey.values()] };
}

export function newExerciseRow(env: Environment, name: string, measure: ExerciseMeasure, equipment: Equipment, loadStepGrams: number | null = null): NewRow<"exercise"> {
  return {
    id: env.newId(),
    name,
    nameKey: exerciseNameKey(name),
    measure,
    equipment,
    loadStepGrams,
    zonesReviewed: false,
    mergedIntoId: null,
    archivedAt: null,
  };
}
