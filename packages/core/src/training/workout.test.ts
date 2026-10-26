import { beforeEach, describe, expect, it } from "vitest";
import type { EpochMs, Id } from "@obnixe/schema";
import { localDateOf } from "../dates.ts";
import { painReportMutations } from "../activity/pain.ts";
import { createTestContext } from "../testing.ts";
import type { TestContext } from "../testing.ts";
import { revert } from "../undo.ts";
import { addExerciseMutations, bringForwardMutations, ExerciseNotFoundError, postponeEntryMutations, replaceExerciseMutations } from "./entries.ts";
import { addExercise, apply, reload, seedProgram, startWorkout, timeZone } from "./fixtures.ts";
import type { SeededProgram } from "./fixtures.ts";
import { finishMutations, interruptMutations, openSessionRow, resumeMutations, SessionStateError, startFreeWorkoutMutations, startWorkoutMutations, VariantNotInSlotError } from "./lifecycle.ts";
import { correctSetMutations, deleteSetMutations, hasPendingDuringPain, InvalidSetError, logSetMutations, skipEntryMutations, stopEntryMutations } from "./sets.ts";
import type { SetValues } from "./sets.ts";
import { workoutProgress } from "./workout.ts";
import type { WorkoutData } from "./workout.ts";

let context: TestContext;
let program: SeededProgram;
let squat: Id;
let bench: Id;
let curl: Id;

beforeEach(() => {
  context = createTestContext();
  squat = addExercise(context, { name: "Squat barre", measure: "load_reps", stepGrams: 2500, zones: ["knee_left", "lower_back"] });
  bench = addExercise(context, { name: "Développé couché", measure: "load_reps", stepGrams: 2500, zones: ["shoulder_right"] });
  curl = addExercise(context, { name: "Curl haltères", measure: "load_reps", stepGrams: 1000, zones: ["elbow_right"] });
  program = seedProgram(context, [
    {
      name: "Séance A",
      sport: "strength",
      items: [
        { exerciseId: squat, sets: 2, repsMin: 6, repsMax: 8, rir: 2, rest: 150, restAfter: 180 },
        { exerciseId: bench, sets: 2, repsMin: 6, repsMax: 10, rir: 2, rest: 120, restAfter: 150 },
        { exerciseId: curl, sets: 1, repsMin: 10, repsMax: 12, rir: 1, rest: 60, restAfter: 0 },
      ],
    },
  ]);
});

function entryId(data: WorkoutData, index: number): Id {
  const found = data.exercises[index];
  if (found === undefined) throw new Error(`No exercise at ${index}`);
  return found.entry.id;
}

function logSet(data: WorkoutData, index: number, values: SetValues, restBeforeSeconds: number | null = null): WorkoutData {
  context.advance(90_000);
  apply(context, logSetMutations(data, { entryId: entryId(data, index), setId: context.env.newId(), values, restBeforeSeconds, completedAt: context.env.now() }));
  return reload(context, data.session.id);
}

const kgReps = (kg: number, reps: number, rir: number | null = 2): SetValues => ({ loadGrams: kg * 1000, reps, durationSeconds: null, rir });

describe("starting a workout", () => {
  it("creates an in-progress session with pending entries from the variant items", () => {
    const data = startWorkout(context, program);
    expect(data.session).toMatchObject({ status: "in_progress", sport: "strength", countsInRotation: true, review: "pending", timeZone, endedAt: null });
    expect(data.session.localDate).toBe(localDateOf(context.env.now(), timeZone));
    expect(data.exercises.map((candidate) => [candidate.exercise.name, candidate.entry.status, candidate.target.sets])).toEqual([
      ["Squat barre", "pending", 2],
      ["Développé couché", "pending", 2],
      ["Curl haltères", "pending", 1],
    ]);
    expect(openSessionRow(context.db)?.id).toBe(data.session.id);
  });

  it("refuses a second open session and mismatched variants", () => {
    startWorkout(context, program);
    expect(() => startWorkout(context, program)).toThrow();
    expect(() =>
      startWorkoutMutations(context.db, context.env.newId, { slotId: program.slotIds[0] as Id, variantId: context.env.newId(), now: context.env.now(), timeZone }),
    ).toThrow(VariantNotInSlotError);
  });
});

describe("logging sets", () => {
  it("advances through sets and exercises with the planned rest", () => {
    let data = startWorkout(context, program);
    expect(workoutProgress(data)).toMatchObject({ currentIndex: 0, setIndex: 0, lastSet: null, restSeconds: null, setsDone: 0, setsPlanned: 5 });
    data = logSet(data, 0, kgReps(82.5, 8));
    expect(workoutProgress(data)).toMatchObject({ currentIndex: 0, setIndex: 1, restSeconds: 150, setsDone: 1 });
    data = logSet(data, 0, kgReps(82.5, 7), 160);
    expect(data.exercises[0]?.entry.status).toBe("done");
    expect(data.exercises[0]?.sets.map((set) => [set.position, set.loadGrams, set.reps, set.restBeforeSeconds])).toEqual([
      [0, 82500, 8, null],
      [1, 82500, 7, 160],
    ]);
    expect(workoutProgress(data)).toMatchObject({ currentIndex: 1, setIndex: 0, restSeconds: 180 });
  });

  it("validates set values against the exercise measure", () => {
    const data = startWorkout(context, program);
    expect(() => logSetMutations(data, { entryId: entryId(data, 0), setId: context.env.newId(), values: kgReps(80, 0), restBeforeSeconds: null, completedAt: context.env.now() })).toThrow(InvalidSetError);
    expect(() =>
      logSetMutations(data, { entryId: entryId(data, 0), setId: context.env.newId(), values: { loadGrams: null, reps: 8, durationSeconds: null, rir: null }, restBeforeSeconds: null, completedAt: context.env.now() }),
    ).toThrow(InvalidSetError);
  });

  it("anchors pain reported during a set to the set once it is validated", () => {
    let data = startWorkout(context, program);
    context.advance(10_000);
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
        levels: new Map([["knee_left", "discomfort"]]),
        tracked: [],
      }).mutations,
    );
    data = reload(context, data.session.id);
    expect(hasPendingDuringPain(data)).toBe(true);
    data = logSet(data, 0, kgReps(80, 8));
    expect(data.pains[0]?.strengthSetId).toBe(data.exercises[0]?.sets[0]?.id);
    expect(hasPendingDuringPain(data)).toBe(false);
  });

  it("corrects and deletes sets, releasing pain anchors", () => {
    let data = logSet(startWorkout(context, program), 0, kgReps(80, 8));
    const setId = data.exercises[0]?.sets[0]?.id as Id;
    apply(context, correctSetMutations(data, setId, kgReps(80, 7, 1)));
    data = reload(context, data.session.id);
    expect(data.exercises[0]?.sets[0]).toMatchObject({ reps: 7, rir: 1 });
    apply(
      context,
      painReportMutations({
        newId: context.env.newId,
        sessionId: data.session.id,
        phase: "between",
        strengthSetId: setId,
        sessionItemId: null,
        occurredAt: context.env.now(),
        timeZone,
        levels: new Map([["lower_back", "discomfort"]]),
        tracked: [],
      }).mutations,
    );
    data = reload(context, data.session.id);
    apply(context, deleteSetMutations(data, setId));
    data = reload(context, data.session.id);
    expect(data.exercises[0]?.sets).toHaveLength(0);
    expect(data.pains[0]?.strengthSetId).toBeNull();
    data = logSet(data, 0, kgReps(80, 8));
    expect(data.exercises[0]?.sets[0]?.position).toBe(0);
  });

  it("undoes a logged set through the journal", () => {
    let data = startWorkout(context, program);
    context.advance(60_000);
    const changesetId = apply(context, logSetMutations(data, { entryId: entryId(data, 0), setId: context.env.newId(), values: kgReps(80, 8), restBeforeSeconds: null, completedAt: context.env.now() }));
    revert(context.db, context.env, { actor: { author: "user", connectionId: null }, changesetId, summary: "Annulation", restoredVersionSummary: () => "" });
    data = reload(context, data.session.id);
    expect(data.exercises[0]?.sets).toHaveLength(0);
  });
});

describe("stopping, skipping and reordering exercises", () => {
  it("stops an exercise with an interrupted set and skips another", () => {
    let data = logSet(startWorkout(context, program), 0, kgReps(80, 8));
    context.advance(30_000);
    apply(context, stopEntryMutations(data, entryId(data, 0), { setId: context.env.newId(), loadGrams: 80_000, restBeforeSeconds: 30, completedAt: context.env.now() }));
    data = reload(context, data.session.id);
    expect(data.exercises[0]?.entry.status).toBe("stopped");
    expect(data.exercises[0]?.sets[1]).toMatchObject({ interrupted: true, reps: null, loadGrams: 80_000 });
    apply(context, skipEntryMutations(data, entryId(data, 1)));
    data = reload(context, data.session.id);
    expect(data.exercises[1]?.entry.status).toBe("skipped");
    expect(workoutProgress(data)).toMatchObject({ currentIndex: 2, setsDone: 1 });
  });

  it("postpones, brings forward and replaces exercises without breaking positions", () => {
    let data = startWorkout(context, program);
    apply(context, postponeEntryMutations(data, entryId(data, 0)));
    data = reload(context, data.session.id);
    expect(data.exercises.map((candidate) => candidate.exercise.name)).toEqual(["Développé couché", "Curl haltères", "Squat barre"]);
    apply(context, bringForwardMutations(data, entryId(data, 2)));
    data = reload(context, data.session.id);
    expect(data.exercises.map((candidate) => candidate.exercise.name)).toEqual(["Squat barre", "Développé couché", "Curl haltères"]);
    const row = addExercise(context, { name: "Rowing haltère", measure: "load_reps", stepGrams: 1000, zones: [] });
    apply(context, replaceExerciseMutations(data, entryId(data, 2), row, context.env.newId()));
    data = reload(context, data.session.id);
    expect(data.exercises[2]?.exercise.name).toBe("Rowing haltère");
    data = logSet(data, 1, kgReps(60, 9));
    apply(context, replaceExerciseMutations(data, entryId(data, 1), curl, context.env.newId()));
    data = reload(context, data.session.id);
    expect(data.exercises.map((candidate) => [candidate.exercise.name, candidate.entry.status, candidate.entry.position])).toEqual([
      ["Squat barre", "pending", 0],
      ["Développé couché", "stopped", 1],
      ["Curl haltères", "pending", 2],
      ["Rowing haltère", "pending", 3],
    ]);
    expect(data.exercises[2]?.target.sets).toBe(2);
  });
});

describe("free workout", () => {
  function startFree(): WorkoutData {
    const started = startFreeWorkoutMutations(context.env.newId, { now: context.env.now(), timeZone });
    apply(context, started.mutations);
    return reload(context, started.sessionId);
  }

  function add(data: WorkoutData, exerciseId: Id): WorkoutData {
    apply(context, addExerciseMutations(context.db, data, exerciseId, context.env.newId()));
    return reload(context, data.session.id);
  }

  it("starts an empty in-progress session outside the rotation", () => {
    const data = startFree();
    expect(data.session).toMatchObject({ status: "in_progress", sport: "strength", slotId: null, variantId: null, countsInRotation: false, review: "pending", endedAt: null });
    expect(data.slot).toBeNull();
    expect(data.exercises).toEqual([]);
    expect(workoutProgress(data)).toMatchObject({ currentIndex: null, setsDone: 0, setsPlanned: 0 });
    expect(openSessionRow(context.db)?.id).toBe(data.session.id);
  });

  it("appends pending exercises without program item and resolves merged exercises", () => {
    let data = add(startFree(), squat);
    const alias = addExercise(context, { name: "Squat ancien", measure: "load_reps", stepGrams: 2500, zones: [] });
    apply(context, [{ kind: "update", table: "exercise", key: alias, patch: { mergedIntoId: curl, archivedAt: context.env.now() } }]);
    data = add(data, alias);
    expect(data.exercises.map((candidate) => [candidate.exercise.name, candidate.entry.status, candidate.entry.position, candidate.entry.programItemId])).toEqual([
      ["Squat barre", "pending", 0, null],
      ["Curl haltères", "pending", 1, null],
    ]);
    expect(data.exercises[0]?.item).toBeNull();
    expect(data.exercises[0]?.target).toMatchObject({ sets: 3, repsMin: null, repsMax: null, rir: null, restSeconds: 120 });
    expect(workoutProgress(data)).toMatchObject({ currentIndex: 0, setIndex: 0 });
    expect(() => addExerciseMutations(context.db, data, context.env.newId(), context.env.newId())).toThrow(ExerciseNotFoundError);
  });

  it("logs sets, keeps appending after the last exercise and finishes like a program session", () => {
    let data = add(startFree(), bench);
    data = logSet(data, 0, kgReps(60, 10));
    data = logSet(data, 0, kgReps(60, 9), 120);
    data = logSet(data, 0, kgReps(60, 8), 120);
    expect(data.exercises[0]?.entry.status).toBe("done");
    expect(workoutProgress(data).currentIndex).toBeNull();
    data = add(data, curl);
    expect(workoutProgress(data)).toMatchObject({ currentIndex: 1, setIndex: 0, restSeconds: 120, setsDone: 3 });
    data = logSet(data, 1, kgReps(12, 12), 90);
    context.advance(60_000);
    apply(context, finishMutations(data, context.env.now()));
    data = reload(context, data.session.id);
    expect(data.session).toMatchObject({ status: "completed", countsInRotation: false, slotId: null });
    expect(data.exercises.map((candidate) => candidate.entry.status)).toEqual(["done", "done"]);
    expect(() => addExerciseMutations(context.db, data, squat, context.env.newId())).toThrow(SessionStateError);
  });

  it("finishes a session without any exercise", () => {
    const data = startFree();
    context.advance(60_000);
    apply(context, finishMutations(data, context.env.now()));
    expect(reload(context, data.session.id).session).toMatchObject({ status: "completed", endedAt: context.env.now() });
    expect(openSessionRow(context.db)).toBeNull();
  });

  it("sizes a free exercise from the previous performance of the same exercise", () => {
    let planned = startWorkout(context, program);
    planned = logSet(planned, 0, kgReps(80, 8));
    planned = logSet(planned, 0, kgReps(80, 8), 150);
    apply(context, finishMutations(planned, context.env.now()));
    context.advance(86_400_000);
    const data = add(startFree(), squat);
    expect(data.exercises[0]?.target.sets).toBe(2);
  });
});

describe("session lifecycle", () => {
  it("interrupts, resumes with paused time, then finishes settling entries", () => {
    let data = logSet(startWorkout(context, program), 0, kgReps(80, 8));
    apply(context, interruptMutations(data.session, context.env.now()));
    data = reload(context, data.session.id);
    expect(data.session).toMatchObject({ status: "interrupted" });
    expect(() => startWorkout(context, program)).toThrow();
    context.advance(600_000);
    apply(context, resumeMutations(data.session, context.env.now()));
    data = reload(context, data.session.id);
    expect(data.session).toMatchObject({ status: "in_progress", endedAt: null, pausedSeconds: 600 });
    expect(() => resumeMutations(data.session, context.env.now())).toThrow(SessionStateError);
    context.advance(60_000);
    const endedAt = context.env.now() as EpochMs;
    apply(context, finishMutations(data, endedAt));
    data = reload(context, data.session.id);
    expect(data.session).toMatchObject({ status: "completed", endedAt });
    expect(data.exercises.map((candidate) => candidate.entry.status)).toEqual(["done", "skipped", "skipped"]);
    expect(openSessionRow(context.db)).toBeNull();
  });

  it("closes an interrupted session at its interruption time", () => {
    let data = logSet(startWorkout(context, program), 0, kgReps(80, 8));
    const interruptedAt = context.env.now();
    apply(context, interruptMutations(data.session, interruptedAt));
    data = reload(context, data.session.id);
    context.advance(86_400_000);
    apply(context, finishMutations(data, context.env.now()));
    expect(reload(context, data.session.id).session).toMatchObject({ status: "completed", endedAt: interruptedAt });
  });
});
