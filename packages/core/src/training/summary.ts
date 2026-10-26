import type { EpochMs, FieldValue, LocalDate, SessionItem, StrengthSet } from "@obnixe/schema";
import { activeSeconds } from "../activity/freeSession.ts";
import { parseGrade } from "../stats/indicators.ts";
import type { Grade } from "../stats/indicators.ts";
import { totalLoadGrams } from "./load.ts";
import type { ExerciseLoad } from "./load.ts";
import type { PreviousPerformance, Progression } from "./progression.ts";
import type { WorkoutData, WorkoutExercise } from "./workout.ts";

export interface BestSet {
  readonly entryId: string;
  readonly loadGrams: number;
  readonly totalLoadGrams: number;
  readonly reps: number;
  readonly estimatedOneRepMaxGrams: number;
}

export interface StrengthSummary {
  readonly durationSeconds: number;
  readonly setsDone: number;
  readonly setsPlanned: number | null;
  readonly volumeGrams: number;
  readonly averageRestSeconds: number | null;
  readonly best: BestSet | null;
}

export function estimatedOneRepMax(loadGrams: number, reps: number): number {
  return reps <= 1 ? loadGrams : Math.round(loadGrams * (1 + reps / 30));
}

export function completedSets(sets: readonly StrengthSet[]): readonly StrengthSet[] {
  return sets.filter((set) => !set.interrupted);
}

export function strengthSummary(data: WorkoutData, now: EpochMs): StrengthSummary {
  let volumeGrams = 0;
  let best: BestSet | null = null;
  const rests: number[] = [];
  let setsDone = 0;
  for (const candidate of data.exercises) {
    for (const set of candidate.sets) {
      if (set.restBeforeSeconds !== null) rests.push(set.restBeforeSeconds);
      if (set.interrupted) continue;
      setsDone += 1;
      const total = totalLoadGrams(set.loadGrams, candidate.exercise);
      if (set.loadGrams === null || total === null || set.reps === null) continue;
      volumeGrams += total * set.reps;
      const estimate = estimatedOneRepMax(total, set.reps);
      if (best === null || estimate > best.estimatedOneRepMaxGrams) {
        best = { entryId: candidate.entry.id, loadGrams: set.loadGrams, totalLoadGrams: total, reps: set.reps, estimatedOneRepMaxGrams: estimate };
      }
    }
  }
  return {
    durationSeconds: activeSeconds(data.session, now),
    setsDone,
    setsPlanned: data.exercises.some((candidate) => candidate.item !== null)
      ? data.exercises.reduce((total, candidate) => total + (candidate.item === null ? completedSets(candidate.sets).length : Math.max(candidate.target.sets, candidate.sets.length)), 0)
      : null,
    volumeGrams,
    averageRestSeconds: rests.length === 0 ? null : Math.round(rests.reduce((total, rest) => total + rest, 0) / rests.length),
    best,
  };
}

export type ExerciseOutcome =
  | { readonly kind: "skipped" }
  | { readonly kind: "stopped"; readonly setsDone: number; readonly setsPlanned: number | null }
  | { readonly kind: "suspended" }
  | { readonly kind: "first" }
  | { readonly kind: "load"; readonly deltaGrams: number; readonly previousDate: LocalDate }
  | { readonly kind: "reps"; readonly delta: number; readonly previousDate: LocalDate }
  | { readonly kind: "duration"; readonly deltaSeconds: number; readonly previousDate: LocalDate }
  | { readonly kind: "same"; readonly previousDate: LocalDate };

const sum = (values: readonly number[]): number => values.reduce((total, value) => total + value, 0);
const topLoad = (sets: readonly StrengthSet[], load: ExerciseLoad): number => Math.max(0, ...sets.map((set) => totalLoadGrams(set.loadGrams, load) ?? 0));

export function exerciseOutcome(current: WorkoutExercise, previous: PreviousPerformance | null, progression: Progression): ExerciseOutcome {
  const done = completedSets(current.sets);
  if (current.entry.status === "skipped" || (current.sets.length === 0 && current.entry.status !== "stopped")) return { kind: "skipped" };
  if (current.entry.status === "stopped") return { kind: "stopped", setsDone: done.length, setsPlanned: current.item === null ? null : current.target.sets };
  if (previous === null) return { kind: "first" };
  const before = completedSets(previous.sets);
  const previousDate = previous.localDate;
  const measure = current.exercise.measure;
  if (measure === "load_reps") {
    const deltaGrams = topLoad(done, current.exercise) - topLoad(before, current.exercise);
    if (deltaGrams !== 0) return { kind: "load", deltaGrams, previousDate };
  }
  if (progression.kind === "suspended") return { kind: "suspended" };
  if (measure === "duration") {
    const deltaSeconds = sum(done.map((set) => set.durationSeconds ?? 0)) - sum(before.map((set) => set.durationSeconds ?? 0));
    return deltaSeconds === 0 ? { kind: "same", previousDate } : { kind: "duration", deltaSeconds, previousDate };
  }
  const delta = sum(done.map((set) => set.reps ?? 0)) - sum(before.map((set) => set.reps ?? 0));
  return delta === 0 ? { kind: "same", previousDate } : { kind: "reps", delta, previousDate };
}

export interface ClimbGradeGroup {
  readonly label: string;
  /** Lowest grade folded into this group, null when the group holds a single grade. */
  readonly lowest: string | null;
  readonly count: number;
  readonly sent: number;
  readonly flash: number;
  readonly attempts: number;
}

export interface ClimbBreakdown {
  readonly count: number;
  readonly sent: number;
  readonly flash: number;
  readonly maxSent: string | null;
  readonly groups: readonly ClimbGradeGroup[];
}

const separateGrades = 3;

export function climbBreakdown(items: readonly SessionItem[]): ClimbBreakdown {
  const parsed = items.map((item) => ({ grade: parseGrade(item.values.grade), result: item.values.result, attempts: typeof item.values.attempts === "number" ? item.values.attempts : 0 }));
  const isSent = (result: FieldValue | undefined): boolean => result === "sent" || result === "flash";
  let maxSent: Grade | null = null;
  for (const entry of parsed) if (entry.grade !== null && isSent(entry.result) && (maxSent === null || entry.grade.index > maxSent.index)) maxSent = entry.grade;
  const ranks = [...new Set(parsed.flatMap((entry) => (entry.grade === null ? [] : [entry.grade.index])))].sort((a, b) => b - a);
  const groups: ClimbGradeGroup[] = [];
  ranks.forEach((rank, index) => {
    if (index > separateGrades) return;
    const folded = index === separateGrades && ranks.length > separateGrades + 1;
    const members = parsed.filter((entry) => entry.grade !== null && (folded ? entry.grade.index <= rank : entry.grade.index === rank));
    const label = members.find((entry) => entry.grade?.index === rank)?.grade?.label ?? "";
    const lowestRank = ranks[ranks.length - 1];
    groups.push({
      label,
      lowest: folded ? (members.find((entry) => entry.grade?.index === lowestRank)?.grade?.label ?? null) : null,
      count: members.length,
      sent: members.filter((entry) => isSent(entry.result)).length,
      flash: members.filter((entry) => entry.result === "flash").length,
      attempts: sum(members.map((entry) => entry.attempts)),
    });
  });
  return {
    count: items.length,
    sent: parsed.filter((entry) => isSent(entry.result)).length,
    flash: parsed.filter((entry) => entry.result === "flash").length,
    maxSent: maxSent?.label ?? null,
    groups,
  };
}
