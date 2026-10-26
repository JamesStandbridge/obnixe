import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { exercise, exerciseZone, painReport, programItem, programSlot, programVariant, programVersion, session, strengthEntry, strengthSet } from "@obnixe/schema";
import type {
  EpochMs,
  Exercise,
  ExerciseMeasure,
  Id,
  PainReport,
  ProgramItem,
  ProgramSlot,
  ProgramVariant,
  ProgramVersion,
  Session,
  StrengthEntry,
  StrengthSet,
  ZoneKey,
} from "@obnixe/schema";
import type { ObnixeDatabase } from "../database.ts";

export interface ExerciseTarget {
  readonly sets: number;
  readonly repsMin: number | null;
  readonly repsMax: number | null;
  readonly durationMinSeconds: number | null;
  readonly durationMaxSeconds: number | null;
  readonly rir: number | null;
  readonly restSeconds: number;
  readonly restAfterSeconds: number;
}

export interface WorkoutExercise {
  readonly entry: StrengthEntry;
  readonly exercise: Exercise;
  readonly item: ProgramItem | null;
  readonly target: ExerciseTarget;
  readonly sets: readonly StrengthSet[];
  readonly zones: readonly ZoneKey[];
}

export interface WorkoutData {
  readonly session: Session;
  readonly slot: ProgramSlot | null;
  readonly variant: ProgramVariant | null;
  readonly version: ProgramVersion | null;
  readonly exercises: readonly WorkoutExercise[];
  readonly pains: readonly PainReport[];
}

export interface LastSet {
  readonly exerciseIndex: number;
  readonly set: StrengthSet;
}

export interface WorkoutProgress {
  readonly currentIndex: number | null;
  readonly setIndex: number;
  readonly lastSet: LastSet | null;
  readonly restSeconds: number | null;
  readonly setsDone: number;
  readonly setsPlanned: number;
}

export class SessionNotFoundError extends Error {
  constructor(readonly sessionId: Id) {
    super(`Session ${sessionId} does not exist`);
  }
}

export class EntryNotFoundError extends Error {
  constructor(readonly entryId: Id) {
    super(`Strength entry ${entryId} is not part of this session`);
  }
}

const defaultRestSeconds = 120;

export function targetFor(item: ProgramItem | null, measure: ExerciseMeasure): ExerciseTarget {
  if (item === null) {
    const timed = measure === "duration";
    return {
      sets: 3,
      repsMin: timed ? null : 8,
      repsMax: timed ? null : 12,
      durationMinSeconds: timed ? 30 : null,
      durationMaxSeconds: timed ? 60 : null,
      rir: 2,
      restSeconds: defaultRestSeconds,
      restAfterSeconds: defaultRestSeconds,
    };
  }
  const restSeconds = item.restSeconds ?? defaultRestSeconds;
  return {
    sets: item.sets,
    repsMin: item.repsMin,
    repsMax: item.repsMax,
    durationMinSeconds: item.durationMinSeconds,
    durationMaxSeconds: item.durationMaxSeconds,
    rir: item.targetRir,
    restSeconds,
    restAfterSeconds: item.restAfterSeconds ?? restSeconds,
  };
}

export function loadWorkout(db: ObnixeDatabase, sessionId: Id): WorkoutData | null {
  const row = db.select().from(session).where(eq(session.id, sessionId)).get();
  if (row === undefined) return null;
  const slot = row.slotId === null ? undefined : db.select().from(programSlot).where(eq(programSlot.id, row.slotId)).get();
  const variant = row.variantId === null ? undefined : db.select().from(programVariant).where(eq(programVariant.id, row.variantId)).get();
  const version = slot === undefined ? undefined : db.select().from(programVersion).where(eq(programVersion.id, slot.versionId)).get();
  const entries = db.select().from(strengthEntry).where(eq(strengthEntry.sessionId, sessionId)).orderBy(asc(strengthEntry.position)).all();
  const entryIds = entries.map((entry) => entry.id);
  const exerciseIds = [...new Set(entries.map((entry) => entry.exerciseId))];
  const itemIds = entries.flatMap((entry) => (entry.programItemId === null ? [] : [entry.programItemId]));
  const exercises = new Map((exerciseIds.length === 0 ? [] : db.select().from(exercise).where(inArray(exercise.id, exerciseIds)).all()).map((found) => [found.id, found]));
  const items = new Map((itemIds.length === 0 ? [] : db.select().from(programItem).where(inArray(programItem.id, itemIds)).all()).map((found) => [found.id, found]));
  const sets = entryIds.length === 0 ? [] : db.select().from(strengthSet).where(inArray(strengthSet.entryId, entryIds)).orderBy(asc(strengthSet.position)).all();
  const zones = exerciseIds.length === 0 ? [] : db.select().from(exerciseZone).where(inArray(exerciseZone.exerciseId, exerciseIds)).all();
  const pains = db
    .select()
    .from(painReport)
    .where(and(eq(painReport.sessionId, sessionId), isNull(painReport.deletedAt)))
    .orderBy(asc(painReport.occurredAt))
    .all();
  return {
    session: row,
    slot: slot ?? null,
    variant: variant ?? null,
    version: version ?? null,
    pains,
    exercises: entries.map((entry) => {
      const found = exercises.get(entry.exerciseId);
      if (found === undefined) throw new Error(`Exercise ${entry.exerciseId} is missing`);
      const item = entry.programItemId === null ? null : (items.get(entry.programItemId) ?? null);
      return {
        entry,
        exercise: found,
        item,
        target: targetFor(item, found.measure),
        sets: sets.filter((set) => set.entryId === entry.id),
        zones: zones.filter((zone) => zone.exerciseId === entry.exerciseId).map((zone) => zone.zone),
      };
    }),
  };
}

export function findExercise(data: WorkoutData, entryId: Id): WorkoutExercise {
  const found = data.exercises.find((candidate) => candidate.entry.id === entryId);
  if (found === undefined) throw new EntryNotFoundError(entryId);
  return found;
}

export function workoutProgress(data: WorkoutData): WorkoutProgress {
  const currentIndex = data.exercises.findIndex((candidate) => candidate.entry.status === "pending");
  let lastSet: LastSet | null = null;
  for (const [exerciseIndex, candidate] of data.exercises.entries()) {
    for (const set of candidate.sets) if (lastSet === null || set.completedAt >= lastSet.set.completedAt) lastSet = { exerciseIndex, set };
  }
  let restSeconds: number | null = null;
  if (lastSet !== null && currentIndex !== -1) {
    const owner = data.exercises[lastSet.exerciseIndex];
    if (owner !== undefined) restSeconds = owner.entry.status === "pending" ? owner.target.restSeconds : owner.target.restAfterSeconds;
  }
  return {
    currentIndex: currentIndex === -1 ? null : currentIndex,
    setIndex: currentIndex === -1 ? 0 : (data.exercises[currentIndex]?.sets.length ?? 0),
    lastSet,
    restSeconds: restSeconds === null || restSeconds <= 0 ? null : restSeconds,
    setsDone: data.exercises.reduce((total, candidate) => total + candidate.sets.filter((set) => !set.interrupted).length, 0),
    setsPlanned: data.exercises.reduce((total, candidate) => total + candidate.target.sets, 0),
  };
}

export function lastActivityAt(data: WorkoutData): EpochMs {
  let latest = data.session.startedAt;
  for (const candidate of data.exercises) for (const set of candidate.sets) if (set.completedAt > latest) latest = set.completedAt;
  return latest;
}
