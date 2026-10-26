import type { EpochMs, Id, PainReport, StrengthSet } from "@obnixe/schema";
import type { Mutation, NewRow } from "../writer.ts";
import { findExercise, lastActivityAt } from "./workout.ts";
import type { WorkoutData, WorkoutExercise } from "./workout.ts";

export interface SetValues {
  readonly loadGrams: number | null;
  readonly reps: number | null;
  readonly durationSeconds: number | null;
  readonly rir: number | null;
}

export class InvalidSetError extends Error {
  constructor(readonly reason: string) {
    super(`Invalid set: ${reason}`);
  }
}

export class SetNotFoundError extends Error {
  constructor(readonly setId: Id) {
    super(`Strength set ${setId} is not part of this session`);
  }
}

export function normalizeSet(target: WorkoutExercise, values: SetValues): SetValues {
  const measure = target.exercise.measure;
  const rir = values.rir === null ? null : Math.min(10, Math.max(0, Math.round(values.rir)));
  switch (measure) {
    case "load_reps": {
      if (values.loadGrams === null || values.loadGrams < 0) throw new InvalidSetError("load is required");
      if (values.reps === null || values.reps <= 0) throw new InvalidSetError("reps must be positive");
      return { loadGrams: Math.round(values.loadGrams), reps: Math.round(values.reps), durationSeconds: null, rir };
    }
    case "bodyweight_reps": {
      if (values.reps === null || values.reps <= 0) throw new InvalidSetError("reps must be positive");
      return { loadGrams: values.loadGrams === null || values.loadGrams <= 0 ? null : Math.round(values.loadGrams), reps: Math.round(values.reps), durationSeconds: null, rir };
    }
    case "duration": {
      if (values.durationSeconds === null || values.durationSeconds <= 0) throw new InvalidSetError("duration must be positive");
      return { loadGrams: null, reps: null, durationSeconds: Math.round(values.durationSeconds), rir };
    }
    default: {
      const unreachable: never = measure;
      throw new Error(`Unhandled measure ${String(unreachable)}`);
    }
  }
}

function nextPosition(target: WorkoutExercise): number {
  return target.sets.reduce((max, set) => Math.max(max, set.position + 1), 0);
}

function unanchoredDuringPains(data: WorkoutData): readonly PainReport[] {
  const since = lastActivityAt(data);
  return data.pains.filter((pain) => pain.phase === "during" && pain.strengthSetId === null && pain.sessionItemId === null && pain.occurredAt >= since);
}

function anchorPains(data: WorkoutData, setId: Id): Mutation[] {
  return unanchoredDuringPains(data).map((pain): Mutation => ({ kind: "update", table: "pain_report", key: pain.id, patch: { strengthSetId: setId } }));
}

export function hasPendingDuringPain(data: WorkoutData): boolean {
  return unanchoredDuringPains(data).length > 0;
}

export interface LogSetRequest {
  readonly entryId: Id;
  readonly setId: Id;
  readonly values: SetValues;
  readonly restBeforeSeconds: number | null;
  readonly completedAt: EpochMs;
}

export function logSetMutations(data: WorkoutData, request: LogSetRequest): Mutation[] {
  const target = findExercise(data, request.entryId);
  const values = normalizeSet(target, request.values);
  const row: NewRow<"strength_set"> = {
    id: request.setId,
    entryId: target.entry.id,
    position: nextPosition(target),
    ...values,
    restBeforeSeconds: request.restBeforeSeconds === null ? null : Math.max(0, Math.round(request.restBeforeSeconds)),
    interrupted: false,
    completedAt: request.completedAt,
  };
  const mutations: Mutation[] = [{ kind: "insert", table: "strength_set", row }, ...anchorPains(data, request.setId)];
  if (target.entry.status === "pending" && target.sets.length + 1 >= target.target.sets) {
    mutations.push({ kind: "update", table: "strength_entry", key: target.entry.id, patch: { status: "done" } });
  }
  return mutations;
}

export interface InterruptedSet {
  readonly setId: Id;
  readonly loadGrams: number | null;
  readonly restBeforeSeconds: number | null;
  readonly completedAt: EpochMs;
}

export function stopEntryMutations(data: WorkoutData, entryId: Id, interrupted: InterruptedSet | null): Mutation[] {
  const target = findExercise(data, entryId);
  const mutations: Mutation[] = [];
  if (interrupted !== null) {
    mutations.push(
      {
        kind: "insert",
        table: "strength_set",
        row: {
          id: interrupted.setId,
          entryId: target.entry.id,
          position: nextPosition(target),
          loadGrams: interrupted.loadGrams,
          reps: null,
          durationSeconds: null,
          rir: null,
          restBeforeSeconds: interrupted.restBeforeSeconds,
          interrupted: true,
          completedAt: interrupted.completedAt,
        },
      },
      ...anchorPains(data, interrupted.setId),
    );
  }
  mutations.push({ kind: "update", table: "strength_entry", key: target.entry.id, patch: { status: "stopped" } });
  return mutations;
}

export function skipEntryMutations(data: WorkoutData, entryId: Id): Mutation[] {
  const target = findExercise(data, entryId);
  return [{ kind: "update", table: "strength_entry", key: target.entry.id, patch: { status: target.sets.length > 0 ? "done" : "skipped" } }];
}

export interface LocatedSet {
  readonly owner: WorkoutExercise;
  readonly set: StrengthSet;
  readonly index: number;
}

export function locateSet(data: WorkoutData, setId: Id): LocatedSet {
  for (const owner of data.exercises) {
    const index = owner.sets.findIndex((set) => set.id === setId);
    const set = owner.sets[index];
    if (set !== undefined) return { owner, set, index };
  }
  throw new SetNotFoundError(setId);
}

export function correctSetMutations(data: WorkoutData, setId: Id, values: SetValues): Mutation[] {
  const { owner, set } = locateSet(data, setId);
  if (set.interrupted) throw new InvalidSetError("interrupted sets cannot be corrected");
  return [{ kind: "update", table: "strength_set", key: set.id, patch: normalizeSet(owner, values) }];
}

export function deleteSetMutations(data: WorkoutData, setId: Id): Mutation[] {
  const { set } = locateSet(data, setId);
  return [
    ...data.pains.filter((pain) => pain.strengthSetId === set.id).map((pain): Mutation => ({ kind: "update", table: "pain_report", key: pain.id, patch: { strengthSetId: null } })),
    { kind: "delete", table: "strength_set", key: set.id },
  ];
}
