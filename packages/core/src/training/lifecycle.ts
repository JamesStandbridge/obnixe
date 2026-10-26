import { and, asc, eq, inArray, isNull, ne } from "drizzle-orm";
import { exercise, programItem, programSlot, programVariant, session } from "@obnixe/schema";
import type { EpochMs, Id, Session } from "@obnixe/schema";
import type { ObnixeDatabase } from "../database.ts";
import type { Mutation } from "../writer.ts";
import { localDateOf } from "./time.ts";
import type { WorkoutData } from "./workout.ts";

export class SlotNotFoundError extends Error {
  constructor(readonly slotId: Id) {
    super(`Program slot ${slotId} does not exist`);
  }
}

export class VariantNotInSlotError extends Error {
  constructor(readonly slotId: Id, readonly variantId: Id) {
    super(`Variant ${variantId} does not belong to slot ${slotId}`);
  }
}

export class NotStrengthSlotError extends Error {
  constructor(readonly slotId: Id) {
    super(`Program slot ${slotId} is not a strength slot`);
  }
}

export class SessionStateError extends Error {
  constructor(readonly sessionId: Id, readonly expected: string) {
    super(`Session ${sessionId} is not ${expected}`);
  }
}

export function openSession(db: ObnixeDatabase): Session | null {
  return db.select().from(session).where(and(ne(session.status, "completed"), isNull(session.deletedAt))).get() ?? null;
}

export interface StartWorkoutRequest {
  readonly slotId: Id;
  readonly variantId: Id;
  readonly now: EpochMs;
  readonly timeZone: string;
}

export interface StartedWorkout {
  readonly sessionId: Id;
  readonly mutations: readonly Mutation[];
}

export function startWorkoutMutations(db: ObnixeDatabase, newId: () => Id, request: StartWorkoutRequest): StartedWorkout {
  const slot = db.select().from(programSlot).where(eq(programSlot.id, request.slotId)).get();
  if (slot === undefined) throw new SlotNotFoundError(request.slotId);
  if (slot.sport !== "strength") throw new NotStrengthSlotError(slot.id);
  const variant = db.select().from(programVariant).where(eq(programVariant.id, request.variantId)).get();
  if (variant === undefined || variant.slotId !== slot.id) throw new VariantNotInSlotError(slot.id, request.variantId);
  const items = db.select().from(programItem).where(eq(programItem.variantId, variant.id)).orderBy(asc(programItem.position)).all();
  const exerciseIds = [...new Set(items.map((item) => item.exerciseId))];
  const merged = new Map(
    (exerciseIds.length === 0 ? [] : db.select({ id: exercise.id, mergedIntoId: exercise.mergedIntoId }).from(exercise).where(inArray(exercise.id, exerciseIds)).all()).map((row) => [row.id, row.mergedIntoId]),
  );
  const sessionId = newId();
  const mutations: Mutation[] = [
    {
      kind: "insert",
      table: "session",
      row: {
        id: sessionId,
        sport: "strength",
        slotId: slot.id,
        variantId: variant.id,
        countsInRotation: true,
        gearId: null,
        title: null,
        status: "in_progress",
        startedAt: request.now,
        endedAt: null,
        pausedSeconds: 0,
        localDate: localDateOf(request.now, request.timeZone),
        timeZone: request.timeZone,
        values: {},
        effort: null,
        sensation: null,
        enjoyment: null,
        note: null,
        review: "pending",
        deletedAt: null,
      },
    },
    ...items.map(
      (item, position): Mutation => ({
        kind: "insert",
        table: "strength_entry",
        row: { id: newId(), sessionId, position, exerciseId: merged.get(item.exerciseId) ?? item.exerciseId, programItemId: item.id, status: "pending", note: null },
      }),
    ),
  ];
  return { sessionId, mutations };
}

function settleEntries(data: WorkoutData): Mutation[] {
  return data.exercises
    .filter((candidate) => candidate.entry.status === "pending")
    .map((candidate): Mutation => ({ kind: "update", table: "strength_entry", key: candidate.entry.id, patch: { status: candidate.sets.length > 0 ? "done" : "skipped" } }));
}

export function finishMutations(data: WorkoutData, now: EpochMs): Mutation[] {
  const { session: current } = data;
  if (current.status === "completed") throw new SessionStateError(current.id, "open");
  const endedAt = current.status === "in_progress" ? now : (current.endedAt ?? now);
  return [{ kind: "update", table: "session", key: current.id, patch: { status: "completed", endedAt } }, ...settleEntries(data)];
}

export function interruptMutations(current: Session, now: EpochMs): Mutation[] {
  if (current.status !== "in_progress") throw new SessionStateError(current.id, "in progress");
  return [{ kind: "update", table: "session", key: current.id, patch: { status: "interrupted", endedAt: now } }];
}

export function resumeMutations(current: Session, now: EpochMs): Mutation[] {
  if (current.status !== "interrupted" || current.endedAt === null) throw new SessionStateError(current.id, "interrupted");
  const paused = Math.max(0, Math.round((now - current.endedAt) / 1000));
  return [{ kind: "update", table: "session", key: current.id, patch: { status: "in_progress", endedAt: null, pausedSeconds: current.pausedSeconds + paused } }];
}
