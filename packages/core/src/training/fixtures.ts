import type { ExerciseMeasure, Id, ZoneKey } from "@obnixe/schema";
import { exerciseNameKey } from "@obnixe/schema";
import type { TestContext } from "../testing.ts";
import { commit } from "../writer.ts";
import type { Mutation } from "../writer.ts";
import { startWorkoutMutations } from "./lifecycle.ts";
import { loadWorkout } from "./workout.ts";
import type { WorkoutData } from "./workout.ts";

export const timeZone = "Europe/Paris";

export function apply(context: TestContext, mutations: readonly Mutation[], summary = "Test"): Id {
  return commit(context.db, context.env, { actor: { author: "user", connectionId: null }, summary, revertsId: null, mutations });
}

export interface ExerciseSpec {
  readonly name: string;
  readonly measure: ExerciseMeasure;
  readonly stepGrams: number | null;
  readonly zones: readonly ZoneKey[];
}

export function addExercise(context: TestContext, spec: ExerciseSpec): Id {
  const id = context.env.newId();
  apply(context, [
    {
      kind: "insert",
      table: "exercise",
      row: { id, name: spec.name, nameKey: exerciseNameKey(spec.name), measure: spec.measure, equipment: "barbell", loadStepGrams: spec.stepGrams, zonesReviewed: true, mergedIntoId: null, archivedAt: null },
    },
    ...spec.zones.map((zone): Mutation => ({ kind: "insert", table: "exercise_zone", row: { exerciseId: id, zone } })),
  ]);
  return id;
}

export interface ItemSpec {
  readonly exerciseId: Id;
  readonly sets: number;
  readonly repsMin: number | null;
  readonly repsMax: number | null;
  readonly durationMin?: number;
  readonly durationMax?: number;
  readonly rir: number | null;
  readonly rest: number;
  readonly restAfter: number;
}

export interface SeededProgram {
  readonly programId: Id;
  readonly versionId: Id;
  readonly slotIds: readonly Id[];
  readonly variantIds: readonly Id[];
  readonly itemIds: readonly (readonly Id[])[];
}

export interface SlotSpec {
  readonly name: string;
  readonly sport: "strength" | "climb";
  readonly items: readonly ItemSpec[];
}

export function seedProgram(context: TestContext, slots: readonly SlotSpec[]): SeededProgram {
  const programId = context.env.newId();
  const versionId = context.env.newId();
  const slotIds = slots.map(() => context.env.newId());
  const variantIds = slots.map(() => context.env.newId());
  const itemIds = slots.map((slot) => slot.items.map(() => context.env.newId()));
  apply(context, [
    { kind: "insert", table: "program", row: { id: programId, status: "active" } },
    { kind: "insert", table: "program_version", row: { id: versionId, programId, number: 1, name: "Base", sessionsPerWeek: 3, copiedFromId: null, summary: null, reason: null } },
    ...slots.flatMap((slot, slotIndex): Mutation[] => {
      const slotId = slotIds[slotIndex] as Id;
      const variantId = variantIds[slotIndex] as Id;
      return [
        { kind: "insert", table: "program_slot", row: { id: slotId, versionId, lineageId: `slot-${slotIndex}` as Id, position: slotIndex, sport: slot.sport, name: slot.name, targetDurationSeconds: null, targetEffort: null, targetValues: {} } },
        { kind: "insert", table: "program_variant", row: { id: variantId, slotId, lineageId: `variant-${slotIndex}` as Id, position: 0, name: "Salle" } },
        ...slot.items.map(
          (item, position): Mutation => ({
            kind: "insert",
            table: "program_item",
            row: {
              id: itemIds[slotIndex]?.[position] as Id,
              variantId,
              lineageId: `item-${slotIndex}-${position}` as Id,
              position,
              exerciseId: item.exerciseId,
              sets: item.sets,
              repsMin: item.repsMin,
              repsMax: item.repsMax,
              durationMinSeconds: item.durationMin ?? null,
              durationMaxSeconds: item.durationMax ?? null,
              targetRir: item.rir,
              restSeconds: item.rest,
              restAfterSeconds: item.restAfter,
            },
          }),
        ),
      ];
    }),
  ]);
  return { programId, versionId, slotIds, variantIds, itemIds };
}

export function startWorkout(context: TestContext, program: SeededProgram, slotIndex = 0): WorkoutData {
  const started = startWorkoutMutations(context.db, context.env.newId, {
    slotId: program.slotIds[slotIndex] as Id,
    variantId: program.variantIds[slotIndex] as Id,
    now: context.env.now(),
    timeZone,
  });
  apply(context, started.mutations);
  return reload(context, started.sessionId);
}

export function reload(context: TestContext, sessionId: Id): WorkoutData {
  const data = loadWorkout(context.db, sessionId);
  if (data === null) throw new Error(`Session ${sessionId} vanished`);
  return data;
}
