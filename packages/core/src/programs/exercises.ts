import { exerciseNameKey } from "@obnixe/schema";
import type { EpochMs, Equipment, Exercise, ExerciseMeasure, Id, LoadMode, ZoneKey } from "@obnixe/schema";
import { rowKey } from "../keys.ts";
import type { Mutation } from "../writer.ts";

export interface ExerciseInput {
  readonly name: string;
  readonly measure: ExerciseMeasure;
  readonly equipment: Equipment;
  readonly loadMode: LoadMode;
  readonly baseGrams: number | null;
  readonly loadStepGrams: number | null;
  readonly zones: readonly ZoneKey[];
}

export type ExerciseIssue =
  | { readonly kind: "name_missing" }
  | { readonly kind: "name_taken"; readonly existing: Exercise }
  | { readonly kind: "load_step_invalid" }
  | { readonly kind: "load_mode_invalid" }
  | { readonly kind: "measure_locked" };

export type ExercisePlan =
  | { readonly ok: true; readonly exerciseId: Id; readonly mutations: readonly [Mutation, ...Mutation[]] }
  | { readonly ok: false; readonly issue: ExerciseIssue };

export function usesLoad(measure: ExerciseMeasure): boolean {
  switch (measure) {
    case "load_reps":
      return true;
    case "bodyweight_reps":
    case "duration":
      return false;
    default: {
      const unreachable: never = measure;
      throw new Error(`Unhandled exercise measure ${String(unreachable)}`);
    }
  }
}

export function isSelectableExercise(exercise: Exercise): boolean {
  return exercise.mergedIntoId === null && exercise.archivedAt === null;
}

export function findExerciseByName(exercises: readonly Exercise[], name: string, exceptId: Id | null = null): Exercise | null {
  const key = exerciseNameKey(name);
  if (key === "") return null;
  return exercises.find((exercise) => exercise.mergedIntoId === null && exercise.nameKey === key && exercise.id !== exceptId) ?? null;
}

export function searchExercises(exercises: readonly Exercise[], query: string): Exercise[] {
  const key = exerciseNameKey(query);
  const words = key === "" ? [] : key.split(" ");
  return exercises
    .filter((exercise) => isSelectableExercise(exercise) && words.every((word) => exercise.nameKey.includes(word)))
    .sort((left, right) => {
      const leftStarts = key !== "" && left.nameKey.startsWith(key) ? 0 : 1;
      const rightStarts = key !== "" && right.nameKey.startsWith(key) ? 0 : 1;
      return leftStarts - rightStarts || left.nameKey.localeCompare(right.nameKey);
    });
}

function inputIssue(input: ExerciseInput, existing: readonly Exercise[], exceptId: Id | null): ExerciseIssue | null {
  if (input.name.trim() === "") return { kind: "name_missing" };
  const taken = findExerciseByName(existing, input.name, exceptId);
  if (taken !== null) return { kind: "name_taken", existing: taken };
  const step = input.loadStepGrams;
  if (input.measure === "duration" ? step !== null : step !== null && (!Number.isInteger(step) || step <= 0)) return { kind: "load_step_invalid" };
  const base = input.baseGrams;
  if ((input.measure === "duration" && input.loadMode !== "total") || (base !== null && (input.loadMode !== "per_side" || !Number.isInteger(base) || base <= 0))) {
    return { kind: "load_mode_invalid" };
  }
  return null;
}

function zoneKey(exerciseId: Id, zone: ZoneKey): string {
  return rowKey("exercise_zone", { exerciseId, zone });
}

export function planCreateExercise(input: ExerciseInput, existing: readonly Exercise[], newId: () => Id): ExercisePlan {
  const issue = inputIssue(input, existing, null);
  if (issue !== null) return { ok: false, issue };
  const exerciseId = newId();
  const name = input.name.trim().replace(/\s+/g, " ");
  return {
    ok: true,
    exerciseId,
    mutations: [
      {
        kind: "insert",
        table: "exercise",
        row: {
          id: exerciseId,
          name,
          nameKey: exerciseNameKey(name),
          measure: input.measure,
          equipment: input.equipment,
          loadMode: input.loadMode,
          baseGrams: input.baseGrams,
          loadStepGrams: input.loadStepGrams,
          zonesReviewed: true,
          mergedIntoId: null,
          archivedAt: null,
        },
      },
      ...[...new Set(input.zones)].map((zone): Mutation => ({ kind: "insert", table: "exercise_zone", row: { exerciseId, zone } })),
    ],
  };
}

export interface ExerciseUpdate {
  readonly exercise: Exercise;
  readonly zones: readonly ZoneKey[];
  readonly inUse: boolean;
  readonly input: ExerciseInput;
}

export type ExerciseUpdatePlan =
  | { readonly ok: true; readonly exerciseId: Id; readonly mutations: readonly Mutation[] }
  | { readonly ok: false; readonly issue: ExerciseIssue };

export function planUpdateExercise(update: ExerciseUpdate, existing: readonly Exercise[]): ExerciseUpdatePlan {
  const { exercise, input } = update;
  const issue = inputIssue(input, existing, exercise.id);
  if (issue !== null) return { ok: false, issue };
  if (update.inUse && input.measure !== exercise.measure) return { ok: false, issue: { kind: "measure_locked" } };
  const name = input.name.trim().replace(/\s+/g, " ");
  const mutations: Mutation[] = [];
  const patch = {
    name,
    nameKey: exerciseNameKey(name),
    measure: input.measure,
    equipment: input.equipment,
    loadMode: input.loadMode,
    baseGrams: input.baseGrams,
    loadStepGrams: input.loadStepGrams,
    zonesReviewed: true,
  };
  const changed = (Object.keys(patch) as (keyof typeof patch)[]).some((column) => patch[column] !== exercise[column]);
  if (changed) mutations.push({ kind: "update", table: "exercise", key: exercise.id, patch });
  const before = new Set(update.zones);
  const after = new Set(input.zones);
  for (const zone of before) if (!after.has(zone)) mutations.push({ kind: "delete", table: "exercise_zone", key: zoneKey(exercise.id, zone) });
  for (const zone of after) if (!before.has(zone)) mutations.push({ kind: "insert", table: "exercise_zone", row: { exerciseId: exercise.id, zone } });
  return { ok: true, exerciseId: exercise.id, mutations };
}

export function normalizeCues(text: string): string | null {
  const cues = text
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return cues === "" ? null : cues;
}

export function planExerciseCues(exercise: Exercise, text: string): Mutation | null {
  const cues = normalizeCues(text);
  if (cues === exercise.cues) return null;
  return { kind: "update", table: "exercise", key: exercise.id, patch: { cues } };
}

export function planArchiveExercise(exercise: Exercise, now: EpochMs): Mutation | null {
  if (exercise.archivedAt !== null) return null;
  return { kind: "update", table: "exercise", key: exercise.id, patch: { archivedAt: now } };
}

export function planRestoreExercise(exercise: Exercise): Mutation | null {
  if (exercise.archivedAt === null || exercise.mergedIntoId !== null) return null;
  return { kind: "update", table: "exercise", key: exercise.id, patch: { archivedAt: null } };
}
