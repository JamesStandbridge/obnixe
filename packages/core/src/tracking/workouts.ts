import { and, desc, eq, gt, isNotNull, isNull } from "drizzle-orm";
import { recording, session } from "@obnixe/schema";
import type { SportKey, WorkoutDuration, WorkoutPlan, WorkoutTarget } from "@obnixe/schema";
import type { ObnixeDatabase } from "../database.ts";
import type { LapSummary } from "./stages/derive.ts";
import { unfoldWorkout } from "./workout.ts";
import type { WorkoutStepRun, WorkoutTargetTally } from "./workout.ts";

/** The recordings `recentSpeedOf` averages. */
const recentRecordings = 10;

/** Duration and distance of a plan (`WKT-001`); `complete` is false when an open step or an unknown speed left a part out. */
export interface WorkoutEstimate {
  readonly durationMs: number;
  readonly distanceMm: number;
  readonly complete: boolean;
}

/** The middle of a pace or speed target in mm/s, else the reference speed. */
export function stepSpeedMmS(target: WorkoutTarget, referenceSpeedMmS: number | null): number | null {
  switch (target.kind) {
    case "pace":
      return 2_000_000 / (target.fastestSecondsPerKm + target.slowestSecondsPerKm);
    case "speed":
      return (target.minMmS + target.maxMmS) / 2;
    case "none":
    case "heart_rate_zone":
    case "heart_rate":
      return referenceSpeedMmS;
    default: {
      const unreachable: never = target;
      throw new Error(`Unhandled workout target ${JSON.stringify(unreachable)}`);
    }
  }
}

interface StepEstimate {
  readonly durationMs: number | null;
  readonly distanceMm: number | null;
}

function stepEstimate(duration: WorkoutDuration, speedMmS: number | null): StepEstimate {
  switch (duration.kind) {
    case "time":
      return { durationMs: duration.ms, distanceMm: speedMmS === null ? null : (duration.ms * speedMmS) / 1000 };
    case "distance":
      return { durationMs: speedMmS === null ? null : (duration.mm / speedMmS) * 1000, distanceMm: duration.mm };
    case "open":
      return { durationMs: null, distanceMm: null };
    default: {
      const unreachable: never = duration;
      throw new Error(`Unhandled workout duration ${JSON.stringify(unreachable)}`);
    }
  }
}

/**
 * `WKT-001`: distance steps take the time of the middle of their pace or speed target, time steps the distance; steps
 * without such a target move at `referenceSpeedMmS` (mm/s), the user's recent speed for the sport, when there is one.
 */
export function workoutEstimate(plan: WorkoutPlan, referenceSpeedMmS: number | null): WorkoutEstimate {
  let durationMs = 0;
  let distanceMm = 0;
  let complete = true;
  for (const step of unfoldWorkout(plan)) {
    const estimate = stepEstimate(step.duration, stepSpeedMmS(step.target, referenceSpeedMmS));
    if (estimate.durationMs === null || estimate.distanceMm === null) complete = false;
    durationMs += estimate.durationMs ?? 0;
    distanceMm += estimate.distanceMm ?? 0;
  }
  return { durationMs: Math.round(durationMs), distanceMm: Math.round(distanceMm), complete };
}

/** The average moving speed of the latest recordings of the sport, in mm/s; null without any. */
export function recentSpeedOf(db: ObnixeDatabase, sport: SportKey): number | null {
  const rows = db
    .select({ distanceMm: recording.distanceMm, movingMs: recording.movingMs })
    .from(recording)
    .innerJoin(session, eq(recording.sessionId, session.id))
    .where(and(eq(session.sport, sport), isNull(session.deletedAt), gt(recording.movingMs, 0)))
    .orderBy(desc(session.startedAt))
    .limit(recentRecordings)
    .all();
  const movingMs = rows.reduce((sum, row) => sum + row.movingMs, 0);
  return movingMs === 0 ? null : (rows.reduce((sum, row) => sum + row.distanceMm, 0) / movingMs) * 1000;
}

/** `WKT-008`: the workout of the latest guided recording of the sport, to fill the quick intervals in. */
export function lastWorkoutOf(db: ObnixeDatabase, sport: SportKey): WorkoutPlan | null {
  return (
    db
      .select({ workout: recording.workout })
      .from(recording)
      .innerJoin(session, eq(recording.sessionId, session.id))
      .where(and(eq(session.sport, sport), isNull(session.deletedAt), isNotNull(recording.workout)))
      .orderBy(desc(session.startedAt))
      .get()?.workout ?? null
  );
}

export interface WorkoutStepRow {
  readonly step: WorkoutStepRun;
  readonly lap: LapSummary;
  /** Share of the judged time inside the target, null when the target was never judged. */
  readonly inTargetPermille: number | null;
}

/** The work repetitions of a guided activity: their total, and their fastest and slowest moving speeds in mm/s. */
export interface WorkRepetitions {
  readonly count: number;
  readonly distanceMm: number;
  readonly movingMs: number;
  readonly fastestMmS: number;
  readonly slowestMmS: number;
}

export interface WorkoutReport {
  readonly rows: readonly WorkoutStepRow[];
  /** Null with fewer than two work repetitions. */
  readonly work: WorkRepetitions | null;
}

/** `WKT-007`: one row per step lap with its share of time in the target, and the summary of the work repetitions. */
export function workoutReport(plan: WorkoutPlan, laps: readonly LapSummary[], tallies: readonly WorkoutTargetTally[]): WorkoutReport {
  const steps = unfoldWorkout(plan);
  const rows = laps.flatMap((lap): WorkoutStepRow[] => {
    const index = lap.bounds.workoutStep;
    const step = index === null ? undefined : steps[index];
    if (index === null || step === undefined) return [];
    const tally = tallies[index];
    const inTargetPermille = step.target.kind === "none" || tally === undefined || tally.judgedMs === 0 ? null : Math.round((tally.insideMs / tally.judgedMs) * 1000);
    return [{ step, lap, inTargetPermille }];
  });
  const work = rows.filter((row) => row.step.intent === "work" && row.lap.movingMs > 0);
  if (work.length < 2) return { rows, work: null };
  const speeds = work.map((row) => (row.lap.distanceMm / row.lap.movingMs) * 1000);
  return {
    rows,
    work: {
      count: work.length,
      distanceMm: work.reduce((sum, row) => sum + row.lap.distanceMm, 0),
      movingMs: work.reduce((sum, row) => sum + row.lap.movingMs, 0),
      fastestMmS: Math.max(...speeds),
      slowestMmS: Math.min(...speeds),
    },
  };
}
