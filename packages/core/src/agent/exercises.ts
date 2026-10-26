import { and, eq, isNull } from "drizzle-orm";
import { exercise, exerciseNameKey } from "@obnixe/schema";
import type { Equipment, Exercise, ExerciseMeasure, Id, LoadMode } from "@obnixe/schema";
import type { Environment, ObnixeDatabase } from "../database.ts";
import { defaultLoadMode } from "../training/load.ts";
import type { ExerciseLoad } from "../training/load.ts";
import type { NewRow } from "../writer.ts";
import { ToolInputError } from "./environment.ts";

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

export interface ExerciseProperties {
  readonly measure: ExerciseMeasure;
  readonly equipment: Equipment;
  readonly loadMode?: LoadMode | undefined;
  readonly baseGrams?: number | undefined;
}

export interface ExerciseRequest {
  readonly exercise: string;
  readonly newExercise?: ExerciseProperties | undefined;
}

const defaultProperties: ExerciseProperties = { measure: "load_reps", equipment: "other" };

export function exerciseLoadOf(name: string, properties: ExerciseProperties): ExerciseLoad {
  const loadMode = properties.loadMode ?? defaultLoadMode(properties.equipment, properties.measure);
  if (properties.measure === "duration" && loadMode !== "total") throw new ToolInputError(`'${name}' is a duration exercise: its loadMode can only be total.`);
  if (properties.baseGrams !== undefined && loadMode !== "per_side") throw new ToolInputError(`'${name}': baseGrams is only allowed with loadMode per_side.`);
  return { loadMode, baseGrams: properties.baseGrams ?? null };
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
    const pending = createdByKey.get(nameKey) ?? newExerciseRow(env, name, request.newExercise ?? defaultProperties);
    createdByKey.set(nameKey, pending);
    resolved.set(request.exercise, { id: pending.id, name: pending.name, measure: pending.measure });
  }
  return { resolved, created: [...createdByKey.values()] };
}

export function newExerciseRow(env: Environment, name: string, properties: ExerciseProperties, loadStepGrams: number | null = null): NewRow<"exercise"> {
  return {
    id: env.newId(),
    name,
    nameKey: exerciseNameKey(name),
    measure: properties.measure,
    equipment: properties.equipment,
    ...exerciseLoadOf(name, properties),
    loadStepGrams,
    zonesReviewed: false,
    mergedIntoId: null,
    archivedAt: null,
  };
}
