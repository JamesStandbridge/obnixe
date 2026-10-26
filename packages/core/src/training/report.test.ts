import { beforeEach, describe, expect, it } from "vitest";
import type { EpochMs, Id, LocalDate, SessionItem } from "@obnixe/schema";
import { createTestContext } from "../testing.ts";
import { painReportMutations, trackedZones } from "../activity/pain.ts";
import type { TestContext } from "../testing.ts";
import { addExercise, apply, reload, seedProgram, startWorkout, timeZone } from "./fixtures.ts";
import type { SeededProgram } from "./fixtures.ts";
import { nextSlot } from "../rotation.ts";
import { addExerciseMutations } from "./entries.ts";
import { finishMutations, startFreeWorkoutMutations } from "./lifecycle.ts";
import { loadSessionReport, sessionHistory } from "./report.ts";
import { reviewMutations, rotationChoice } from "./review.ts";
import { correctSetMutations, logSetMutations, stopEntryMutations } from "./sets.ts";
import type { SetValues } from "./sets.ts";
import { climbBreakdown } from "./summary.ts";
import type { WorkoutData } from "./workout.ts";

let context: TestContext;
let program: SeededProgram;
let squat: Id;
let bench: Id;

beforeEach(() => {
  context = createTestContext();
  squat = addExercise(context, { name: "Squat barre", measure: "load_reps", stepGrams: 2500, zones: ["knee_left"] });
  bench = addExercise(context, { name: "Développé couché", measure: "load_reps", stepGrams: 2500, zones: ["shoulder_right"] });
  program = seedProgram(context, [
    {
      name: "Séance A",
      sport: "strength",
      items: [
        { exerciseId: squat, sets: 2, repsMin: 6, repsMax: 8, rir: 2, rest: 150, restAfter: 180 },
        { exerciseId: bench, sets: 2, repsMin: 6, repsMax: 10, rir: 2, rest: 120, restAfter: 150 },
      ],
    },
    { name: "Bloc libre", sport: "climb", items: [] },
  ]);
});

const kgReps = (kg: number, reps: number, rir: number | null = 2): SetValues => ({ loadGrams: kg * 1000, reps, durationSeconds: null, rir });

function logSet(data: WorkoutData, index: number, values: SetValues, rest: number | null): WorkoutData {
  context.advance(120_000);
  apply(context, logSetMutations(data, { entryId: data.exercises[index]?.entry.id as Id, setId: context.env.newId(), values, restBeforeSeconds: rest, completedAt: context.env.now() }), `Série ${index}`);
  return reload(context, data.session.id);
}

function finish(data: WorkoutData): WorkoutData {
  context.advance(60_000);
  apply(context, finishMutations(data, context.env.now()), "Séance terminée");
  return reload(context, data.session.id);
}

function completeTopSession(): WorkoutData {
  let data = startWorkout(context, program);
  data = logSet(data, 0, kgReps(80, 8), null);
  data = logSet(data, 0, kgReps(80, 8), 150);
  data = logSet(data, 1, kgReps(57.5, 10), 180);
  data = logSet(data, 1, kgReps(57.5, 10), 120);
  return finish(data);
}

describe("loadSessionReport", () => {
  it("summarises duration, sets, volume, rest and best set, and compares with the previous session", () => {
    completeTopSession();
    context.advance(2 * 86_400_000);
    let data = startWorkout(context, program);
    data = logSet(data, 0, kgReps(82.5, 8), null);
    data = logSet(data, 0, kgReps(82.5, 7), 160);
    data = logSet(data, 1, kgReps(60, 9), 170);
    context.advance(30_000);
    apply(
      context,
      painReportMutations({
        newId: context.env.newId,
        sessionId: data.session.id,
        phase: "during",
        strengthSetId: null,
        sessionItemId: null,
        occurredAt: context.env.now(),
        timeZone,
        levels: new Map([["shoulder_right", "stop"]]),
        tracked: [],
      }).mutations,
    );
    data = reload(context, data.session.id);
    context.advance(10_000);
    apply(context, stopEntryMutations(data, data.exercises[1]?.entry.id as Id, { setId: context.env.newId(), loadGrams: 60_000, restBeforeSeconds: 40, completedAt: context.env.now() }));
    data = finish(reload(context, data.session.id));

    const report = loadSessionReport(context.db, data.session.id, context.env.now());
    expect(report).not.toBeNull();
    if (report === null) return;
    expect(report.summary).toMatchObject({ setsDone: 3, setsPlanned: 4, volumeGrams: 82_500 * 15 + 60_000 * 9, averageRestSeconds: Math.round((160 + 170 + 40) / 3) });
    expect(report.summary.best).toMatchObject({ loadGrams: 82_500, reps: 8 });
    expect(report.summary.durationSeconds).toBe(Math.round(((data.session.endedAt ?? 0) - data.session.startedAt) / 1000));
    expect(report.exercises.map((exercise) => exercise.outcome)).toEqual([
      { kind: "load", deltaGrams: 2500, previousDate: expect.any(String) },
      { kind: "stopped", setsDone: 1, setsPlanned: 2 },
    ]);
    expect(report.exercises[0]?.progression.kind).toBe("increase_load");
    const pain = report.data.pains[0];
    expect(pain === undefined ? null : report.painAnchors.get(pain.id)).toEqual({ kind: "set", exerciseName: "Développé couché", setIndex: 1 });
  });
});

describe("climbBreakdown", () => {
  const item = (position: number, grade: string, result: string, attempts: number): SessionItem => ({
    id: `item-${position}` as Id,
    sessionId: "session" as Id,
    position,
    values: { grade: `fontainebleau:${grade}`, result, attempts },
    recordedAt: 0 as EpochMs,
  });

  it("counts sends and flashes and groups the lowest grades together", () => {
    const summary = climbBreakdown([
      item(0, "5", "flash", 1),
      item(1, "5+", "flash", 1),
      item(2, "6A", "sent", 2),
      item(3, "6A+", "project", 4),
      item(4, "6A", "flash", 1),
      item(5, "6B", "sent", 3),
      item(6, "6B", "project", 5),
    ]);
    expect(summary).toMatchObject({ count: 7, sent: 5, flash: 3, maxSent: "6B" });
    expect(summary.groups).toEqual([
      { label: "6B", andBelow: false, count: 2, sent: 1, flash: 0, attempts: 8 },
      { label: "6A+", andBelow: false, count: 1, sent: 0, flash: 0, attempts: 4 },
      { label: "6A", andBelow: false, count: 2, sent: 2, flash: 1, attempts: 3 },
      { label: "5+", andBelow: true, count: 2, sent: 2, flash: 2, attempts: 2 },
    ]);
  });
});

describe("review", () => {
  it("records feelings and end-of-session pains, opening zone tracking for painful zones", () => {
    const data = completeTopSession();
    const choice = rotationChoice(context.db, data.session);
    expect(choice).toMatchObject({ slot: { name: "Séance A" }, next: { name: "Bloc libre" } });
    apply(
      context,
      reviewMutations({
        session: data.session,
        effort: "hard",
        sensation: "normal",
        enjoyment: 4,
        note: "  Bonne séance ",
        countsInRotation: true,
        pains: [
          { zone: "shoulder_right", level: "discomfort" },
          { zone: "knee_left", level: "none" },
          { zone: "lower_back", level: null },
        ],
        existingEndPains: [],
        tracked: trackedZones(context.db),
        now: context.env.now(),
        newId: context.env.newId,
      }),
    );
    let reviewed = reload(context, data.session.id);
    expect(reviewed.session).toMatchObject({ effort: "hard", sensation: "normal", enjoyment: 4, note: "Bonne séance", review: "done", countsInRotation: true });
    expect(reviewed.pains.map((pain) => [pain.zone, pain.level, pain.phase])).toEqual([
      ["shoulder_right", "discomfort", "end"],
      ["knee_left", "none", "end"],
    ]);
    expect(trackedZones(context.db)).toEqual(["shoulder_right"]);

    context.advance(60_000);
    apply(
      context,
      reviewMutations({
        session: reviewed.session,
        effort: null,
        sensation: null,
        enjoyment: null,
        note: null,
        countsInRotation: false,
        pains: [
          { zone: "shoulder_right", level: "stop" },
          { zone: "knee_left", level: null },
        ],
        existingEndPains: reviewed.pains,
        tracked: trackedZones(context.db),
        now: context.env.now(),
        newId: context.env.newId,
      }),
    );
    reviewed = reload(context, data.session.id);
    expect(reviewed.session).toMatchObject({ countsInRotation: false, review: "done" });
    expect(reviewed.pains.map((pain) => [pain.zone, pain.level])).toEqual([["shoulder_right", "stop"]]);
  });

  it("marks an empty review as skipped and keeps an out-of-program session out of the rotation even when it matches the next slot", () => {
    const data = completeTopSession();
    apply(
      context,
      reviewMutations({
        session: data.session,
        effort: null,
        sensation: null,
        enjoyment: null,
        note: " ",
        countsInRotation: true,
        pains: [],
        existingEndPains: [],
        tracked: [],
        now: context.env.now(),
        newId: context.env.newId,
      }),
    );
    expect(reload(context, data.session.id).session.review).toBe("skipped");
    const climbId = context.env.newId();
    context.advance(3_600_000);
    apply(context, [
      {
        kind: "insert",
        table: "session",
        row: {
          id: climbId,
          sport: "climb",
          slotId: null,
          variantId: null,
          countsInRotation: false,
          gearId: null,
          title: null,
          status: "completed",
          startedAt: context.env.now(),
          endedAt: context.env.now(),
          pausedSeconds: 0,
          localDate: "2026-10-24" as LocalDate,
          timeZone,
          values: { discipline: "boulder" },
          effort: null,
          sensation: null,
          enjoyment: null,
          note: null,
          review: "pending",
          deletedAt: null,
        },
      },
    ]);
    const climb = reload(context, climbId);
    expect(nextSlot(context.db)?.slot.name).toBe("Bloc libre");
    expect(rotationChoice(context.db, climb.session)).toBeNull();
    apply(
      context,
      reviewMutations({
        session: climb.session,
        effort: "easy",
        sensation: null,
        enjoyment: null,
        note: null,
        countsInRotation: true,
        pains: [],
        existingEndPains: [],
        tracked: [],
        now: context.env.now(),
        newId: context.env.newId,
      }),
    );
    expect(reload(context, climbId).session).toMatchObject({ slotId: null, countsInRotation: false, review: "done" });
    expect(nextSlot(context.db)?.slot.name).toBe("Bloc libre");
  });
});

describe("free workout report and review", () => {
  function completeFreeSession(): WorkoutData {
    const started = startFreeWorkoutMutations(context.env.newId, { now: context.env.now(), timeZone });
    apply(context, started.mutations);
    let data = reload(context, started.sessionId);
    for (const exerciseId of [squat, bench]) {
      apply(context, addExerciseMutations(context.db, data, exerciseId, context.env.newId()));
      data = reload(context, data.session.id);
    }
    data = logSet(data, 0, kgReps(80, 8), null);
    data = logSet(data, 0, kgReps(80, 9), 150);
    data = logSet(data, 1, kgReps(50, 10), 120);
    context.advance(10_000);
    apply(context, stopEntryMutations(data, data.exercises[1]?.entry.id as Id, null));
    return finish(reload(context, data.session.id));
  }

  it("derives progression from the previous performance of the exercise only and reports no plan", () => {
    completeTopSession();
    context.advance(86_400_000);
    const data = completeFreeSession();
    const report = loadSessionReport(context.db, data.session.id, context.env.now());
    expect(report).not.toBeNull();
    if (report === null) return;
    expect(report.data.slot).toBeNull();
    expect(report.summary).toMatchObject({ setsDone: 3, setsPlanned: null, volumeGrams: 80_000 * 17 + 50_000 * 10 });
    expect(report.exercises.map((exercise) => exercise.progression.kind)).toEqual(["repeat", "repeat"]);
    expect(report.exercises[0]?.progression.sets.map((suggestion) => suggestion.loadGrams)).toEqual([80_000, 80_000]);
    expect(report.exercises.map((exercise) => exercise.outcome)).toEqual([
      { kind: "reps", delta: 1, previousDate: expect.any(String) },
      { kind: "stopped", setsDone: 1, setsPlanned: null },
    ]);
  });

  it("suggests a first attempt for an exercise never performed and counts planned sets only for program items", () => {
    const data = completeFreeSession();
    const report = loadSessionReport(context.db, data.session.id, context.env.now());
    if (report === null) throw new Error("Report missing");
    expect(report.exercises[0]?.previous).toBeNull();
    expect(report.exercises[0]?.progression).toMatchObject({ kind: "first", sets: [{ loadGrams: 0, reps: 8, durationSeconds: null }, expect.anything(), expect.anything()] });
    expect(report.exercises[0]?.outcome).toEqual({ kind: "first" });
  });

  it("offers no rotation slot and stays out of the rotation after review", () => {
    const before = nextSlot(context.db)?.slot.name;
    const data = completeFreeSession();
    expect(rotationChoice(context.db, data.session)).toBeNull();
    apply(
      context,
      reviewMutations({
        session: data.session,
        effort: "moderate",
        sensation: null,
        enjoyment: 3,
        note: null,
        countsInRotation: data.session.countsInRotation,
        pains: [],
        existingEndPains: [],
        tracked: [],
        now: context.env.now(),
        newId: context.env.newId,
      }),
    );
    expect(reload(context, data.session.id).session).toMatchObject({ slotId: null, countsInRotation: false, review: "done" });
    expect(nextSlot(context.db)?.slot.name).toBe(before);
  });
});

describe("sessionHistory", () => {
  it("collapses the live session into its creation and lists later corrections", () => {
    let data = completeTopSession();
    context.advance(3_600_000);
    const setId = data.exercises[0]?.sets[1]?.id as Id;
    apply(context, correctSetMutations(data, setId, kgReps(80, 7)), "Squat barre, série 2 : 8 → 7 rép.");
    data = reload(context, data.session.id);
    context.advance(60_000);
    apply(context, [{ kind: "update", table: "session", key: data.session.id, patch: { startedAt: (data.session.startedAt - 86_400_000) as EpochMs, endedAt: ((data.session.endedAt ?? 0) - 86_400_000) as EpochMs } }], "Date ou heure modifiée");
    const history = sessionHistory(context.db, data.session.id);
    expect(history.map((entry) => [entry.summary, entry.creation, entry.revertible])).toEqual([
      ["Test", true, false],
      ["Squat barre, série 2 : 8 → 7 rép.", false, true],
      ["Date ou heure modifiée", false, true],
    ]);
    expect(history[0]?.createdAt).toBe(data.session.endedAt);
  });
});
