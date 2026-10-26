import { beforeEach, describe, expect, it } from "vitest";
import { sports } from "@obnixe/schema";
import type { FieldValues, Id, IndicatorDefinition, LocalDate } from "@obnixe/schema";
import { createTestContext } from "../testing.ts";
import { estimatedOneRepMaxKg, exerciseMetrics, exerciseSeries, exerciseSessions, lastPerformances, preferredExerciseMetric, trainedExercises } from "./exercise.ts";
import { gradePyramid, indicatorBetter, indicatorOver, indicatorSeries, parseGrade } from "./indicators.ts";
import type { IndicatorSession } from "./indicators.ts";
import { completedSessions } from "./sessions.ts";
import { Seeder } from "./testing.ts";

let seed: Seeder;

beforeEach(() => {
  seed = new Seeder(createTestContext());
});

describe("exercise progress", () => {
  it("builds estimated 1RM, top load and volume per session with records", () => {
    const bench = seed.exercise("Développé couché", "load_reps", ["shoulder_right"]);
    seed.session({ sport: "strength", date: "2026-09-01", entries: [{ exerciseId: bench, sets: [{ kg: 60, reps: 9, rir: 2 }, { kg: 60, reps: 8, rir: 2 }] }] });
    seed.session({ sport: "strength", date: "2026-09-08", entries: [{ exerciseId: bench, sets: [{ kg: 62.5, reps: 8, rir: 2 }, { kg: 62.5, reps: 8, rir: 1 }] }] });
    seed.session({ sport: "strength", date: "2026-09-15", entries: [{ exerciseId: bench, sets: [{ kg: 40, reps: 15, rir: 3 }] }] });
    seed.session({ sport: "strength", date: "2026-09-22", entries: [{ exerciseId: bench, sets: [{ kg: 60, reps: 9, rir: 2, interrupted: true }] }], deleted: true });
    seed.session({ sport: "strength", date: "2026-09-29", entries: [{ exerciseId: bench, sets: [{ kg: 65, reps: 6, rir: 2 }] }] });

    const sessions = exerciseSessions(seed.context.db, bench);
    expect(sessions).toHaveLength(4);
    const e1rm = exerciseSeries(sessions, "e1rm");
    expect(e1rm.map((point) => point.value)).toEqual([82, 83.3, 64, 82.3]);
    expect(e1rm.map((point) => point.isRecord)).toEqual([false, true, false, false]);
    expect(e1rm[2]?.unreliable).toBe(true);
    expect(exerciseSeries(sessions, "load").map((point) => point.value)).toEqual([60, 62.5, 40, 65]);
    expect(exerciseSeries(sessions, "load").map((point) => point.isRecord)).toEqual([false, true, false, true]);
    expect(exerciseSeries(sessions, "volume").map((point) => point.value)).toEqual([1020, 1000, 600, 390]);
    expect(preferredExerciseMetric("load_reps", sessions)).toBe("e1rm");
    expect(estimatedOneRepMaxKg({ loadGrams: 100_000, reps: 5, rir: null, durationSeconds: null, interrupted: false })).toBeCloseTo(116.667, 2);
  });

  it("prefers top load when most estimates are unreliable and handles bodyweight and timed work", () => {
    const curl = seed.exercise("Curl haltères");
    const pullup = seed.exercise("Tractions", "bodyweight_reps");
    const plank = seed.exercise("Gainage latéral", "duration");
    seed.session({
      sport: "strength",
      date: "2026-10-01",
      entries: [
        { exerciseId: curl, sets: [{ kg: 12, reps: 12, rir: 2 }] },
        { exerciseId: pullup, sets: [{ kg: null, reps: 6, rir: 1 }, { kg: null, reps: 5, rir: 1 }] },
        { exerciseId: plank, sets: [{ kg: null, seconds: 40 }, { kg: null, seconds: 35 }] },
      ],
    });
    expect(preferredExerciseMetric("load_reps", exerciseSessions(seed.context.db, curl))).toBe("load");
    expect(exerciseMetrics("bodyweight_reps")).toEqual(["best_reps", "total_reps"]);
    expect(exerciseSeries(exerciseSessions(seed.context.db, pullup), "best_reps")[0]?.value).toBe(6);
    expect(exerciseSeries(exerciseSessions(seed.context.db, pullup), "total_reps")[0]?.value).toBe(11);
    expect(exerciseSeries(exerciseSessions(seed.context.db, plank), "best_duration")[0]?.value).toBe(40);
    expect(exerciseSeries(exerciseSessions(seed.context.db, plank), "total_duration")[0]?.value).toBe(75);
    const trained = trainedExercises(seed.context.db).map((item) => [item.exercise.name, item.sessions, item.lastDate]);
    expect(trained).toEqual(expect.arrayContaining([["Curl haltères", 1, "2026-10-01"], ["Tractions", 1, "2026-10-01"], ["Gainage latéral", 1, "2026-10-01"]]));
  });

  it("folds merged exercises into their target and finds the last top set", () => {
    const rdl = seed.exercise("Soulevé de terre roumain");
    const old = seed.exercise("SDT roumain");
    seed.session({ sport: "strength", date: "2026-09-01", entries: [{ exerciseId: old, sets: [{ kg: 80, reps: 8, rir: 2 }] }] });
    seed.session({ sport: "strength", date: "2026-09-08", entries: [{ exerciseId: rdl, sets: [{ kg: 85, reps: 8, rir: 2 }, { kg: 90, reps: 6, rir: 2 }] }] });
    seed.write([{ kind: "update", table: "exercise", key: old, patch: { mergedIntoId: rdl, archivedAt: seed.context.env.now() } }]);
    expect(exerciseSessions(seed.context.db, rdl)).toHaveLength(2);
    expect(trainedExercises(seed.context.db).map((item) => [item.exercise.id, item.sessions])).toEqual([[rdl, 2]]);
    const last = lastPerformances(seed.context.db, [rdl]).get(rdl);
    expect(last?.localDate).toBe("2026-09-08");
    expect(last?.top.loadGrams).toBe(90_000);
  });
});

function indicator(sport: "run" | "climb" | "hike", key: string): IndicatorDefinition {
  const found = sports[sport].indicators.find((item) => item.key === key);
  if (found === undefined) throw new Error(`No indicator ${key}`);
  return found;
}

function climb(id: string, localDate: string, discipline: string, items: readonly FieldValues[]): IndicatorSession {
  return { id: id as Id, localDate: localDate as LocalDate, values: { discipline }, items, durationSeconds: 5400 };
}

describe("catalog indicators", () => {
  it("computes run pace per session and pooled over a period", () => {
    seed.session({ sport: "run", date: "2026-10-04", minutes: 40, values: { kind: "easy", distance: 8000 } });
    seed.session({ sport: "run", date: "2026-10-08", minutes: 50, values: { kind: "easy", distance: 10000 } });
    seed.session({ sport: "run", date: "2026-10-10", minutes: 30, values: { kind: "easy" } });
    const sessions = completedSessions(seed.context.db);
    const pace = indicator("run", "pace");
    expect(indicatorSeries(pace, sports.run, sessions).map((point) => point.value)).toEqual([300, 300]);
    expect(indicatorOver(pace, sports.run, sessions)).toEqual({ kind: "number", value: 300 });
    expect(indicatorBetter(pace)).toBe("lower");
    expect(indicatorBetter(indicator("hike", "speed"))).toBe("higher");
  });

  it("compares grades by scale order, applies filters and keeps the dominant scale", () => {
    expect(parseGrade("fontainebleau:6A+")).toEqual({ scale: "fontainebleau", index: 6, label: "6A+" });
    expect(parseGrade("fontainebleau:6Z")).toBeNull();
    const sessions = [
      climb("a", "2026-10-03", "boulder", [
        { grade: "fontainebleau:6A", attempts: 1, result: "flash" },
        { grade: "fontainebleau:6A+", attempts: 3, result: "sent" },
        { grade: "fontainebleau:7A", attempts: 6, result: "project" },
      ]),
      climb("b", "2026-10-10", "boulder", [
        { grade: "fontainebleau:6C+", attempts: 4, result: "sent" },
        { grade: "fontainebleau:5+", attempts: 1, result: "flash" },
      ]),
      climb("c", "2026-10-12", "lead", [{ grade: "french:7a", attempts: 2, result: "sent" }]),
    ];
    const maxSent = indicator("climb", "max_sent");
    expect(indicatorOver(maxSent, sports.climb, sessions)).toEqual({ kind: "grade", grade: { scale: "fontainebleau", index: 10, label: "6C+" } });
    const series = indicatorSeries(maxSent, sports.climb, sessions);
    expect(series.map((point) => point.grade?.label)).toEqual(["6A+", "6C+"]);
    expect(series.map((point) => point.isRecord)).toEqual([false, true]);
    expect(indicatorOver(indicator("climb", "flash_rate"), sports.climb, sessions)).toEqual({ kind: "number", value: 2 / 6 });
    expect(indicatorSeries(indicator("climb", "flash_rate"), sports.climb, sessions).map((point) => point.value)).toEqual([1 / 3, 1 / 2, 0]);
  });

  it("handles count and session-scope aggregates", () => {
    const sessions: IndicatorSession[] = [
      { id: "r1" as Id, localDate: "2026-10-01" as LocalDate, values: { kind: "easy", distance: 8000 }, items: [], durationSeconds: 2400 },
      { id: "r2" as Id, localDate: "2026-10-03" as LocalDate, values: { kind: "intervals", distance: 9000 }, items: [], durationSeconds: 2600 },
    ];
    expect(indicatorOver({ type: "count", key: "intervals", label: "Fractionnés", filter: { field: "kind", anyOf: ["intervals"] } }, sports.run, sessions)).toEqual({ kind: "number", value: 1 });
    expect(indicatorOver({ type: "aggregate", key: "longest", label: "Plus longue", scope: "session", field: "distance", fn: "max", filter: null }, sports.run, sessions)).toEqual({ kind: "number", value: 9000 });
    expect(indicatorOver({ type: "aggregate", key: "total", label: "Total", scope: "session", field: "distance", fn: "sum", filter: { field: "kind", anyOf: ["easy"] } }, sports.run, sessions)).toEqual({ kind: "number", value: 8000 });
    expect(indicatorOver({ type: "share", key: "easy", label: "Part de footing", filter: { field: "kind", anyOf: ["easy"] } }, sports.run, sessions)).toEqual({ kind: "number", value: 0.5 });
    expect(indicatorOver({ type: "count", key: "all", label: "Sorties", filter: null }, sports.run, [])).toBeNull();
  });

  it("builds a grade pyramid by result", () => {
    const pyramid = gradePyramid(sports.climb, [
      climb("a", "2026-10-03", "boulder", [
        { grade: "fontainebleau:6A", attempts: 1, result: "flash" },
        { grade: "fontainebleau:6A", attempts: 2, result: "sent" },
        { grade: "fontainebleau:6B", attempts: 5, result: "project" },
      ]),
    ]);
    expect(pyramid?.scale).toBe("fontainebleau");
    expect(pyramid?.options.map((option) => option.key)).toEqual(["flash", "sent", "project"]);
    expect(pyramid?.levels.map((level) => [level.grade.label, level.counts, level.total])).toEqual([
      ["6B", { project: 1 }, 1],
      ["6A", { flash: 1, sent: 1 }, 2],
    ]);
    expect(gradePyramid(sports.run, [])).toBeNull();
  });
});
