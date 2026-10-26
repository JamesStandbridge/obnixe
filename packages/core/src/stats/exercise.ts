import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { exercise, session, strengthEntry, strengthSet } from "@obnixe/schema";
import type { EpochMs, Exercise, ExerciseMeasure, Id, LocalDate } from "@obnixe/schema";
import type { ObnixeDatabase } from "../database.ts";
import { groupBy } from "./sessions.ts";
import { recordFlags } from "./series.ts";
import type { Measured } from "./series.ts";

export type ExerciseMetric = "e1rm" | "load" | "volume" | "best_reps" | "total_reps" | "best_duration" | "total_duration";

export function exerciseMetrics(measure: ExerciseMeasure): readonly [ExerciseMetric, ...ExerciseMetric[]] {
  switch (measure) {
    case "load_reps":
      return ["e1rm", "load", "volume"];
    case "bodyweight_reps":
      return ["best_reps", "total_reps"];
    case "duration":
      return ["best_duration", "total_duration"];
    default: {
      const unreachable: never = measure;
      throw new Error(`Unhandled measure ${String(unreachable)}`);
    }
  }
}

export interface ExerciseSet {
  readonly loadGrams: number | null;
  readonly reps: number | null;
  readonly durationSeconds: number | null;
  readonly rir: number | null;
  readonly interrupted: boolean;
}

export interface ExerciseSession {
  readonly sessionId: Id;
  readonly localDate: LocalDate;
  readonly startedAt: EpochMs;
  readonly sets: readonly ExerciseSet[];
}

function exerciseIdsWithMerged(db: ObnixeDatabase, exerciseId: Id): Id[] {
  const merged = db.select({ id: exercise.id }).from(exercise).where(eq(exercise.mergedIntoId, exerciseId)).all();
  return [exerciseId, ...merged.map((row) => row.id)];
}

export function exerciseSessions(db: ObnixeDatabase, exerciseId: Id): ExerciseSession[] {
  const ids = exerciseIdsWithMerged(db, exerciseId);
  const rows = db
    .select({
      sessionId: session.id,
      localDate: session.localDate,
      startedAt: session.startedAt,
      loadGrams: strengthSet.loadGrams,
      reps: strengthSet.reps,
      durationSeconds: strengthSet.durationSeconds,
      rir: strengthSet.rir,
      interrupted: strengthSet.interrupted,
    })
    .from(strengthSet)
    .innerJoin(strengthEntry, eq(strengthSet.entryId, strengthEntry.id))
    .innerJoin(session, eq(strengthEntry.sessionId, session.id))
    .where(and(inArray(strengthEntry.exerciseId, ids), eq(session.status, "completed"), isNull(session.deletedAt)))
    .orderBy(asc(session.startedAt), asc(strengthEntry.position), asc(strengthSet.position))
    .all();
  return [...groupBy(rows, (row) => row.sessionId).values()].map((sets) => {
    const first = sets[0];
    if (first === undefined) throw new Error("Empty set group");
    return {
      sessionId: first.sessionId,
      localDate: first.localDate,
      startedAt: first.startedAt,
      sets: sets.map(({ loadGrams, reps, durationSeconds, rir, interrupted }) => ({ loadGrams, reps, durationSeconds, rir, interrupted })),
    };
  });
}

export function estimatedOneRepMaxKg(set: ExerciseSet): number | null {
  if (set.loadGrams === null || set.reps === null || set.reps === 0) return null;
  return (set.loadGrams / 1000) * (1 + (set.reps + (set.rir ?? 0)) / 30);
}

export function isUnreliableEstimate(set: ExerciseSet): boolean {
  return (set.reps ?? 0) + (set.rir ?? 0) > 12;
}

export interface ExercisePoint extends Measured {
  readonly sessionId: Id;
  readonly top: ExerciseSet | null;
  readonly setCount: number;
  readonly interrupted: boolean;
  readonly isRecord: boolean;
}

function best<T>(values: readonly T[], score: (value: T) => number | null): T | null {
  let winner: T | null = null;
  let winnerScore = -Infinity;
  for (const value of values) {
    const current = score(value);
    if (current !== null && current > winnerScore) {
      winner = value;
      winnerScore = current;
    }
  }
  return winner;
}

interface MetricValue {
  readonly value: number;
  readonly top: ExerciseSet | null;
  readonly unreliable: boolean;
}

function metricValue(metric: ExerciseMetric, sets: readonly ExerciseSet[]): MetricValue | null {
  switch (metric) {
    case "e1rm": {
      const top = best(sets, estimatedOneRepMaxKg);
      const value = top === null ? null : estimatedOneRepMaxKg(top);
      return top === null || value === null ? null : { value: Math.round(value * 10) / 10, top, unreliable: isUnreliableEstimate(top) };
    }
    case "load": {
      const top = best(sets, (set) => (set.loadGrams === null || (set.reps ?? 0) === 0 ? null : set.loadGrams * 1000 + (set.reps ?? 0)));
      return top?.loadGrams == null ? null : { value: top.loadGrams / 1000, top, unreliable: false };
    }
    case "volume": {
      const value = sets.reduce((sum, set) => sum + ((set.loadGrams ?? 0) * (set.reps ?? 0)) / 1000, 0);
      return value === 0 ? null : { value: Math.round(value), top: null, unreliable: false };
    }
    case "best_reps": {
      const top = best(sets, (set) => set.reps);
      return top?.reps == null ? null : { value: top.reps, top, unreliable: false };
    }
    case "total_reps": {
      const value = sets.reduce((sum, set) => sum + (set.reps ?? 0), 0);
      return value === 0 ? null : { value, top: null, unreliable: false };
    }
    case "best_duration": {
      const top = best(sets, (set) => set.durationSeconds);
      return top?.durationSeconds == null ? null : { value: top.durationSeconds, top, unreliable: false };
    }
    case "total_duration": {
      const value = sets.reduce((sum, set) => sum + (set.durationSeconds ?? 0), 0);
      return value === 0 ? null : { value, top: null, unreliable: false };
    }
    default: {
      const unreachable: never = metric;
      throw new Error(`Unhandled metric ${String(unreachable)}`);
    }
  }
}

export function exerciseSeries(sessions: readonly ExerciseSession[], metric: ExerciseMetric): ExercisePoint[] {
  const points = sessions.flatMap((item) => {
    const measured = metricValue(metric, item.sets);
    if (measured === null) return [];
    return [
      {
        sessionId: item.sessionId,
        date: item.localDate,
        value: measured.value,
        unreliable: measured.unreliable,
        top: measured.top,
        setCount: item.sets.length,
        interrupted: item.sets.some((set) => set.interrupted),
      },
    ];
  });
  const records = recordFlags(points, "higher");
  return points.map((point, index) => ({ ...point, isRecord: records[index] ?? false }));
}

export function preferredExerciseMetric(measure: ExerciseMeasure, sessions: readonly ExerciseSession[]): ExerciseMetric {
  const metrics = exerciseMetrics(measure);
  if (measure !== "load_reps") return metrics[0];
  const tops = sessions.map((item) => best(item.sets, estimatedOneRepMaxKg)).filter((top): top is ExerciseSet => top !== null);
  return tops.filter(isUnreliableEstimate).length > tops.length / 2 ? "load" : "e1rm";
}

export interface TrainedExercise {
  readonly exercise: Exercise;
  readonly sessions: number;
  readonly lastDate: LocalDate;
}

export function trainedExercises(db: ObnixeDatabase): TrainedExercise[] {
  const rows = db
    .select({
      exerciseId: sql<Id>`coalesce(${exercise.mergedIntoId}, ${exercise.id})`,
      sessions: sql<number>`count(distinct ${session.id})`,
      lastDate: sql<LocalDate>`max(${session.localDate})`,
    })
    .from(strengthSet)
    .innerJoin(strengthEntry, eq(strengthSet.entryId, strengthEntry.id))
    .innerJoin(session, eq(strengthEntry.sessionId, session.id))
    .innerJoin(exercise, eq(strengthEntry.exerciseId, exercise.id))
    .where(and(eq(session.status, "completed"), isNull(session.deletedAt)))
    .groupBy(sql`coalesce(${exercise.mergedIntoId}, ${exercise.id})`)
    .all();
  if (rows.length === 0) return [];
  const exercises = new Map(
    db
      .select()
      .from(exercise)
      .where(inArray(exercise.id, rows.map((row) => row.exerciseId)))
      .all()
      .map((row) => [row.id, row]),
  );
  return rows.flatMap((row) => {
    const found = exercises.get(row.exerciseId);
    return found === undefined ? [] : [{ exercise: found, sessions: Number(row.sessions), lastDate: row.lastDate }];
  });
}

export interface LastPerformance {
  readonly exerciseId: Id;
  readonly localDate: LocalDate;
  readonly top: ExerciseSet;
}

export function lastPerformances(db: ObnixeDatabase, exerciseIds: readonly Id[]): Map<Id, LastPerformance> {
  const result = new Map<Id, LastPerformance>();
  if (exerciseIds.length === 0) return result;
  const merged = db.select({ id: exercise.id, into: exercise.mergedIntoId }).from(exercise).where(inArray(exercise.mergedIntoId, [...exerciseIds])).all();
  const canonical = new Map<Id, Id>(exerciseIds.map((id) => [id, id]));
  for (const row of merged) if (row.into !== null) canonical.set(row.id, row.into);
  const rows = db
    .select({
      exerciseId: strengthEntry.exerciseId,
      sessionId: session.id,
      localDate: session.localDate,
      startedAt: session.startedAt,
      loadGrams: strengthSet.loadGrams,
      reps: strengthSet.reps,
      durationSeconds: strengthSet.durationSeconds,
      rir: strengthSet.rir,
      interrupted: strengthSet.interrupted,
    })
    .from(strengthSet)
    .innerJoin(strengthEntry, eq(strengthSet.entryId, strengthEntry.id))
    .innerJoin(session, eq(strengthEntry.sessionId, session.id))
    .where(and(inArray(strengthEntry.exerciseId, [...canonical.keys()]), eq(session.status, "completed"), isNull(session.deletedAt)))
    .all();
  const byExercise = groupBy(rows, (row) => canonical.get(row.exerciseId) ?? row.exerciseId);
  for (const [exerciseId, sets] of byExercise) {
    const latest = sets.reduce((winner, row) => (row.startedAt > winner.startedAt ? row : winner));
    const sameSession = sets.filter((row) => row.sessionId === latest.sessionId);
    const top = best(sameSession, (row) => (row.loadGrams ?? 0) * 1000 + (row.reps ?? 0) + (row.durationSeconds ?? 0));
    if (top === null) continue;
    result.set(exerciseId, {
      exerciseId,
      localDate: latest.localDate,
      top: { loadGrams: top.loadGrams, reps: top.reps, durationSeconds: top.durationSeconds, rir: top.rir, interrupted: top.interrupted },
    });
  }
  return result;
}
