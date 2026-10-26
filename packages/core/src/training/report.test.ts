import { beforeEach, describe, expect, it } from "vitest";
import type { EpochMs, Id, LocalDate, SessionItem } from "@obnixe/schema";
import { createTestContext } from "../testing.ts";
import type { TestContext } from "../testing.ts";
import { addExercise, apply, reload, seedProgram, startWorkout, timeZone } from "./fixtures.ts";
import type { SeededProgram } from "./fixtures.ts";
import { finishMutations } from "./lifecycle.ts";
import { sessionPainMutations, trackedZones } from "./pain.ts";
import { loadSessionReport, sessionHistory } from "./report.ts";
import { reviewMutations, rotationChoice } from "./review.ts";
import { correctSetMutations, logSetMutations, stopEntryMutations } from "./sets.ts";
import type { SetValues } from "./sets.ts";
import { climbSummary } from "./summary.ts";
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
      sessionPainMutations({
        newId: context.env.newId,
        sessionId: data.session.id,
        phase: "during",
        strengthSetId: null,
        occurredAt: context.env.now(),
        localDate: data.session.localDate,
        timeZone,
        levels: new Map([["shoulder_right", "stop"]]),
        tracked: [],
      }),
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

describe("climbSummary", () => {
  const item = (position: number, grade: string, result: string, attempts: number): SessionItem => ({
    id: `item-${position}` as Id,
    sessionId: "session" as Id,
    position,
    values: { grade: `fontainebleau:${grade}`, result, attempts },
    recordedAt: 0 as EpochMs,
  });

  it("counts sends and flashes and groups the lowest grades together", () => {
    const summary = climbSummary([
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
    expect(choice).toMatchObject({ assigned: true, slot: { name: "Séance A" }, next: { name: "Bloc libre" } });
    apply(
      context,
      reviewMutations({
        session: data.session,
        effort: "hard",
        sensation: "normal",
        enjoyment: 4,
        note: "  Bonne séance ",
        rotation: { slotId: data.session.slotId, countsInRotation: true },
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
        rotation: { slotId: reviewed.session.slotId, countsInRotation: false },
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

  it("marks an empty review as skipped and can assign a free session to the next matching slot", () => {
    const data = completeTopSession();
    apply(
      context,
      reviewMutations({
        session: data.session,
        effort: null,
        sensation: null,
        enjoyment: null,
        note: " ",
        rotation: { slotId: data.session.slotId, countsInRotation: true },
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
    const choice = rotationChoice(context.db, climb.session);
    expect(choice).toMatchObject({ assigned: false, slot: { name: "Bloc libre" }, next: { name: "Séance A" } });
  });
});

describe("sessionHistory", () => {
  it("collapses the live session into its creation and lists later corrections", () => {
    let data = completeTopSession();
    context.advance(3_600_000);
    const setId = data.exercises[0]?.sets[1]?.id as Id;
    apply(context, correctSetMutations(data, setId, kgReps(80, 7)), "Squat barre, série 2 : 8 → 7 rép.");
    data = reload(context, data.session.id);
    const history = sessionHistory(context.db, data.session.id, data.session.endedAt);
    expect(history.map((entry) => [entry.summary, entry.creation, entry.revertible])).toEqual([
      ["Test", true, false],
      ["Squat barre, série 2 : 8 → 7 rép.", false, true],
    ]);
    expect(history[0]?.createdAt).toBe(data.session.endedAt);
  });
});
