import { and, desc, eq, isNull, lt, ne } from "drizzle-orm";
import { programItem, session, strengthEntry, strengthSet } from "@obnixe/schema";
import type { EpochMs, ExerciseMeasure, Id, LocalDate, StrengthEntryStatus, StrengthSet } from "@obnixe/schema";
import type { ObnixeDatabase } from "../database.ts";
import type { ExerciseTarget } from "./workout.ts";

export const durationStepSeconds = 5;

export interface PerformedSet {
  readonly loadGrams: number | null;
  readonly reps: number | null;
  readonly durationSeconds: number | null;
  readonly rir: number | null;
  readonly interrupted: boolean;
}

export interface PreviousPerformance {
  readonly sessionId: Id;
  readonly startedAt: EpochMs;
  readonly localDate: LocalDate;
  readonly entryStatus: StrengthEntryStatus;
  readonly sets: readonly StrengthSet[];
}

export interface PreviousPerformanceQuery {
  readonly exerciseId: Id;
  readonly itemLineageId: Id | null;
  readonly before: EpochMs;
  readonly excludeSessionId: Id;
}

const historyDepth = 20;

export function previousPerformance(db: ObnixeDatabase, query: PreviousPerformanceQuery): PreviousPerformance | null {
  const candidates = db
    .select({ entryId: strengthEntry.id, entryStatus: strengthEntry.status, sessionId: session.id, startedAt: session.startedAt, localDate: session.localDate, lineageId: programItem.lineageId })
    .from(strengthEntry)
    .innerJoin(session, eq(strengthEntry.sessionId, session.id))
    .leftJoin(programItem, eq(strengthEntry.programItemId, programItem.id))
    .where(
      and(
        eq(strengthEntry.exerciseId, query.exerciseId),
        isNull(session.deletedAt),
        ne(session.status, "in_progress"),
        ne(session.id, query.excludeSessionId),
        lt(session.startedAt, query.before),
      ),
    )
    .orderBy(desc(session.startedAt))
    .limit(historyDepth)
    .all();
  const ordered = query.itemLineageId === null ? candidates : [...candidates.filter((candidate) => candidate.lineageId === query.itemLineageId), ...candidates.filter((candidate) => candidate.lineageId !== query.itemLineageId)];
  for (const candidate of ordered) {
    const sets = db.select().from(strengthSet).where(eq(strengthSet.entryId, candidate.entryId)).orderBy(strengthSet.position).all();
    if (sets.some((set) => !set.interrupted)) {
      return { sessionId: candidate.sessionId, startedAt: candidate.startedAt, localDate: candidate.localDate, entryStatus: candidate.entryStatus, sets };
    }
  }
  return null;
}

export type ProgressionKind = "first" | "increase_load" | "add_reps" | "repeat" | "suspended";

export interface SetSuggestion {
  readonly loadGrams: number | null;
  readonly reps: number | null;
  readonly durationSeconds: number | null;
}

export interface Progression {
  readonly kind: ProgressionKind;
  readonly topReached: boolean;
  readonly previous: readonly PerformedSet[];
  readonly sets: readonly SetSuggestion[];
}

export interface ProgressionRequest {
  readonly measure: ExerciseMeasure;
  readonly target: ExerciseTarget;
  readonly stepGrams: number | null;
  readonly previous: readonly PerformedSet[];
  readonly painful: boolean;
}

function reachedTop(request: ProgressionRequest, completed: readonly PerformedSet[]): boolean {
  const { target } = request;
  if (completed.length < target.sets) return false;
  const rirOk = completed.every((set) => set.rir === null || target.rir === null || set.rir >= target.rir - 1);
  if (!rirOk) return false;
  if (request.measure === "duration") {
    const max = target.durationMaxSeconds;
    return max !== null && completed.every((set) => (set.durationSeconds ?? 0) >= max);
  }
  const max = target.repsMax;
  return max !== null && completed.every((set) => (set.reps ?? 0) >= max);
}

function repeatOf(set: PerformedSet): SetSuggestion {
  return { loadGrams: set.loadGrams, reps: set.reps, durationSeconds: set.durationSeconds };
}

function withExtraEffort(request: ProgressionRequest, set: PerformedSet): SetSuggestion | null {
  const { target } = request;
  if (set.rir === null || target.rir === null || set.rir <= target.rir) return null;
  if (request.measure === "duration") {
    const max = target.durationMaxSeconds;
    if (set.durationSeconds === null || max === null || set.durationSeconds >= max) return null;
    return { ...repeatOf(set), durationSeconds: Math.min(max, set.durationSeconds + durationStepSeconds) };
  }
  const max = target.repsMax;
  if (set.reps === null || max === null || set.reps >= max) return null;
  return { ...repeatOf(set), reps: set.reps + 1 };
}

export function suggestProgression(request: ProgressionRequest): Progression {
  const { target, measure } = request;
  const completed = request.previous.filter((set) => !set.interrupted);
  const count = Math.max(1, target.sets);
  if (completed.length === 0) {
    const first: SetSuggestion = {
      loadGrams: measure === "load_reps" ? 0 : null,
      reps: measure === "duration" ? null : (target.repsMin ?? 8),
      durationSeconds: measure === "duration" ? (target.durationMinSeconds ?? 30) : null,
    };
    return { kind: "first", topReached: false, previous: completed, sets: Array.from({ length: count }, () => first) };
  }
  const previousAt = (index: number): PerformedSet => {
    const set = completed[Math.min(index, completed.length - 1)];
    if (set === undefined) throw new Error("Previous performance has no completed set");
    return set;
  };
  const repeated = Array.from({ length: count }, (_, index) => repeatOf(previousAt(index)));
  const topReached = reachedTop(request, completed);
  if (topReached) {
    const canAddLoad = measure === "load_reps" && request.stepGrams !== null && request.stepGrams > 0;
    if (!canAddLoad) return { kind: "repeat", topReached, previous: completed, sets: repeated };
    if (request.painful) return { kind: "suspended", topReached, previous: completed, sets: repeated };
    const heaviest = Math.max(...completed.map((set) => set.loadGrams ?? 0));
    const increased: SetSuggestion = { loadGrams: heaviest + (request.stepGrams ?? 0), reps: target.repsMin, durationSeconds: null };
    return { kind: "increase_load", topReached, previous: completed, sets: Array.from({ length: count }, () => increased) };
  }
  const extra = Array.from({ length: count }, (_, index) => withExtraEffort(request, previousAt(index)));
  if (extra.every((set) => set === null)) return { kind: "repeat", topReached, previous: completed, sets: repeated };
  if (request.painful) return { kind: "suspended", topReached, previous: completed, sets: repeated };
  return { kind: "add_reps", topReached, previous: completed, sets: extra.map((set, index) => set ?? repeatOf(previousAt(index))) };
}

export interface SetDraft extends SetSuggestion {
  readonly suggested: boolean;
}

export function draftFor(progression: Progression, done: readonly PerformedSet[], setIndex: number): SetDraft {
  const before = setIndex > 0 ? done[setIndex - 1] : undefined;
  if (before !== undefined && !before.interrupted) return { ...repeatOf(before), suggested: false };
  const suggestion = progression.sets[Math.min(setIndex, progression.sets.length - 1)];
  if (suggestion === undefined) return { loadGrams: null, reps: null, durationSeconds: null, suggested: true };
  return { ...suggestion, suggested: true };
}

export function previousSetAt(progression: Progression, setIndex: number): PerformedSet | null {
  const { previous } = progression;
  if (previous.length === 0) return null;
  return previous[Math.min(setIndex, previous.length - 1)] ?? null;
}
