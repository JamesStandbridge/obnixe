import { beforeEach, describe, expect, it } from "vitest";
import { commit, freeTarget, suggestProgression } from "@obnixe/core";
import type { Actor, Mutation, NewRow, PerformedSet, Progression, SetDraft, WorkoutExercise } from "@obnixe/core";
import { exerciseNameKey } from "@obnixe/schema";
import type { EpochMs, ExerciseMeasure, Id, LocalDate, PainLevel, ZoneKey } from "@obnixe/schema";
import { describeComparison, isDraftValid, liveProgression, loadLiveWorkout, rangeText, setText, targetText } from "@/features/training/workout/liveWorkout";
import type { Draft, LiveWorkout } from "@/features/training/workout/liveWorkout";
import { db, environment } from "../../../../test/mocks/database.ts";

const user: Actor = { author: "user", connectionId: null };
const timeZone = "Europe/Paris";
const lastWeek = Date.UTC(2026, 9, 19, 17, 0) as EpochMs;
const today = Date.UTC(2026, 9, 26, 17, 0) as EpochMs;

function write(mutations: Mutation[]): void {
  commit(db(), environment, { actor: user, summary: "Test", revertsId: null, mutations });
}

function exerciseRow(name: string, measure: ExerciseMeasure): NewRow<"exercise"> {
  return {
    id: environment.newId(),
    name,
    nameKey: exerciseNameKey(name),
    measure,
    equipment: measure === "load_reps" ? "barbell" : "bodyweight",
    loadMode: "total",
    baseGrams: null,
    loadStepGrams: null,
    zonesReviewed: true,
    mergedIntoId: null,
    archivedAt: null,
  };
}

function sessionRow(startedAt: EpochMs, localDate: string, completed: boolean): NewRow<"session"> {
  return {
    id: environment.newId(),
    sport: "strength",
    slotId: null,
    variantId: null,
    countsInRotation: false,
    gearId: null,
    title: null,
    status: completed ? "completed" : "in_progress",
    startedAt,
    endedAt: completed ? ((startedAt + 3_600_000) as EpochMs) : null,
    pausedSeconds: 0,
    localDate: localDate as LocalDate,
    timeZone,
    values: {},
    effort: null,
    sensation: null,
    enjoyment: null,
    note: null,
    review: completed ? "skipped" : "pending",
    deletedAt: null,
  };
}

interface SetValues {
  readonly loadGrams: number | null;
  readonly reps: number | null;
  readonly durationSeconds: number | null;
  readonly rir: number | null;
}

function entryWithSets(sessionId: Id, exerciseId: Id, position: number, sets: readonly SetValues[], at: EpochMs): Mutation[] {
  const entryId = environment.newId();
  return [
    { kind: "insert", table: "strength_entry", row: { id: entryId, sessionId, position, exerciseId, programItemId: null, status: sets.length === 0 ? "pending" : "done", note: null } },
    ...sets.map(
      (set, index): Mutation => ({
        kind: "insert",
        table: "strength_set",
        row: { id: environment.newId(), entryId, position: index, ...set, restBeforeSeconds: null, interrupted: false, completedAt: (at + index * 120_000) as EpochMs },
      }),
    ),
  ];
}

function painRow(zone: ZoneKey, level: PainLevel, occurredAt: EpochMs): NewRow<"pain_report"> {
  return {
    id: environment.newId(),
    zone,
    level,
    occurredAt,
    localDate: "2026-10-25" as LocalDate,
    timeZone,
    sessionId: previousId,
    phase: "end",
    strengthSetId: null,
    sessionItemId: null,
    checkInId: null,
    note: null,
    deletedAt: null,
  };
}

const squatSet = (reps: number, rir: number | null = 2): SetValues => ({ loadGrams: 80_000, reps, durationSeconds: null, rir });

let live: LiveWorkout;
let squat: WorkoutExercise;
let plank: WorkoutExercise;
let currentId: Id;
let previousId: Id;

beforeEach(() => {
  const squatRow = exerciseRow("Squat", "load_reps");
  const plankRow = exerciseRow("Gainage", "duration");
  const previous = sessionRow(lastWeek, "2026-10-19", true);
  const current = sessionRow(today, "2026-10-26", false);
  currentId = current.id;
  previousId = previous.id;
  write([
    { kind: "insert", table: "exercise", row: squatRow },
    { kind: "insert", table: "exercise", row: plankRow },
    { kind: "insert", table: "exercise_zone", row: { exerciseId: squatRow.id, zone: "knee_right" } },
    { kind: "insert", table: "session", row: previous },
    ...entryWithSets(previous.id, squatRow.id, 0, [squatSet(8), squatSet(8), squatSet(7, 1)], lastWeek),
    ...entryWithSets(previous.id, plankRow.id, 1, [{ loadGrams: null, reps: null, durationSeconds: 60, rir: null }], lastWeek),
    { kind: "insert", table: "session", row: current },
    ...entryWithSets(current.id, squatRow.id, 0, [], today),
    ...entryWithSets(current.id, plankRow.id, 1, [], today),
  ]);
  const loaded = loadLiveWorkout(current.id);
  if (loaded === null) throw new Error("The live workout did not load");
  live = loaded;
  const [first, second] = loaded.data.exercises;
  if (first === undefined || second === undefined) throw new Error("Missing exercises");
  squat = first;
  plank = second;
});

function ranged(target: WorkoutExercise, repsMin: number, repsMax: number): WorkoutExercise {
  return { ...target, target: { ...target.target, sets: 3, repsMin, repsMax, rir: null } };
}

let painsLogged = 0;

function withPain(level: PainLevel): LiveWorkout {
  painsLogged += 1;
  write([{ kind: "insert", table: "pain_report", row: painRow("knee_right", level, (today + painsLogged * 1000) as EpochMs) }]);
  const reloaded = loadLiveWorkout(currentId);
  if (reloaded === null) throw new Error("The live workout did not reload");
  return reloaded;
}

describe("loadLiveWorkout", () => {
  it("loads the session with the previous performance of each exercise, pains and tracked zones", () => {
    expect(loadLiveWorkout("missing" as Id)).toBeNull();
    expect(live.data.session.id).toBe(currentId);
    expect(squat.zones).toEqual(["knee_right"]);
    expect(squat.target.sets).toBe(3);
    expect(live.previous.get(squat.entry.id)?.sets.map((set) => set.reps)).toEqual([8, 8, 7]);
    expect(live.previous.get(plank.entry.id)?.sets.map((set) => set.durationSeconds)).toEqual([60]);
    expect(live.latestPains.size).toBe(0);
    expect(live.tracked).toEqual([]);

    write([{ kind: "insert", table: "pain_report", row: painRow("knee_right", "discomfort", lastWeek) }, { kind: "insert", table: "pain_report", row: painRow("knee_right", "stop", today) }]);
    expect(loadLiveWorkout(currentId)?.latestPains.get("knee_right")?.level).toBe("stop");
  });
});

describe("liveProgression", () => {
  it("repeats a free exercise and adds load once the top of the range is reached", () => {
    expect(liveProgression(live, squat, "kg").kind).toBe("repeat");
    const progression = liveProgression(live, ranged(squat, 6, 7), "kg");
    expect(progression.kind).toBe("increase_load");
    expect(progression.sets[0]).toEqual({ loadGrams: 82_500, reps: 6, durationSeconds: null });
    expect(liveProgression(live, ranged(squat, 6, 7), "lb").sets[0]?.loadGrams).toBeGreaterThan(80_000);
  });

  it("suspends the progression while a zone of the exercise hurts", () => {
    expect(liveProgression(withPain("discomfort"), ranged(squat, 6, 7), "kg").kind).toBe("suspended");
    expect(liveProgression(withPain("none"), ranged(squat, 6, 7), "kg").kind).toBe("increase_load");
  });
});

describe("isDraftValid", () => {
  const empty: Draft = { loadGrams: null, reps: null, durationSeconds: null, rir: null };

  it("follows the exercise measure", () => {
    expect(isDraftValid(squat, empty)).toBe(false);
    expect(isDraftValid(squat, { ...empty, reps: 8 })).toBe(false);
    expect(isDraftValid(squat, { ...empty, loadGrams: 0, reps: 8 })).toBe(true);
    expect(isDraftValid(squat, { ...empty, loadGrams: 80_000, reps: 0 })).toBe(false);
    expect(isDraftValid(plank, { ...empty, durationSeconds: 45 })).toBe(true);
    expect(isDraftValid(plank, { ...empty, durationSeconds: 0, reps: 10 })).toBe(false);
    const pullUp: WorkoutExercise = { ...squat, exercise: { ...squat.exercise, measure: "bodyweight_reps" } };
    expect(isDraftValid(pullUp, { ...empty, reps: 5 })).toBe(true);
    expect(isDraftValid(pullUp, empty)).toBe(false);
  });
});

describe("set and target texts", () => {
  it("writes a set as a clock, a load times reps, or bare reps", () => {
    expect(setText({ loadGrams: null, reps: null, durationSeconds: 75 }, "kg")).toBe("1:15");
    expect(setText({ loadGrams: 82_500, reps: 6, durationSeconds: null }, "kg")).toBe("82,5 × 6");
    expect(setText({ loadGrams: 0, reps: 12, durationSeconds: null }, "kg")).toBe("12 rép.");
    expect(setText({ loadGrams: null, reps: null, durationSeconds: null }, "kg")).toBe("0 rép.");
  });

  it("writes the target and its range", () => {
    expect(targetText(squat)).toBe("3 séries");
    expect(rangeText(squat)).toBe("");
    expect(targetText(ranged(squat, 6, 8))).toBe("3 × 6–8");
    expect(rangeText(ranged(squat, 6, 8))).toBe("6–8");
    expect(targetText(ranged(squat, 5, 5))).toBe("3 × 5");
    expect(rangeText(ranged(squat, 5, 5))).toBe("5");
    const timed: WorkoutExercise = { ...plank, target: { ...plank.target, sets: 2, durationMinSeconds: 30, durationMaxSeconds: 45 } };
    expect(targetText(timed)).toBe("2 × 30–45 s");
    expect(rangeText(timed)).toBe("30–45");
    const fixed: WorkoutExercise = { ...plank, target: { ...plank.target, sets: 2, durationMinSeconds: 60, durationMaxSeconds: 60 } };
    expect(targetText(fixed)).toBe("2 × 60 s");
    expect(rangeText(fixed)).toBe("60");
  });
});

describe("describeComparison", () => {
  const previousSet: PerformedSet = { loadGrams: 80_000, reps: 8, durationSeconds: null, rir: 2, interrupted: false };
  const repeat: Progression = suggestProgression({ measure: "load_reps", target: { ...freeTarget(null), sets: 1 }, stepGrams: 2500, previous: [previousSet], painful: false });

  function compare(overrides: Partial<Parameters<typeof describeComparison>[0]>): ReturnType<typeof describeComparison> {
    const base: SetDraft = { loadGrams: 80_000, reps: 8, durationSeconds: null, suggested: true };
    return describeComparison({
      target: squat,
      progression: repeat,
      previous: previousSet,
      draft: { loadGrams: 80_000, reps: 8, durationSeconds: null, rir: null },
      base,
      setIndex: 0,
      editing: false,
      unit: "kg",
      stepGrams: 2500,
      latestPains: live.latestPains,
      ...overrides,
    });
  }

  it("says when the exercise is new", () => {
    expect(compare({ previous: null })).toEqual({ mark: null, lead: "Première fois", previous: null });
  });

  it("compares the draft with the previous set", () => {
    expect(compare({})).toEqual({ mark: null, lead: "Comme la dernière fois", previous: "préc. 80 × 8 · RIR 2" });
    expect(compare({ draft: { loadGrams: 82_500, reps: 6, durationSeconds: null, rir: null } }).lead).toBe("+2,5 kg · −2 rép.");
    expect(compare({ previous: { ...previousSet, rir: 5 } }).previous).toBe("préc. 80 × 8 · RIR 4+");
    expect(compare({ previous: { ...previousSet, rir: null } }).previous).toBe("préc. 80 × 8");
    const timedPrevious: PerformedSet = { loadGrams: null, reps: null, durationSeconds: 60, rir: null, interrupted: false };
    expect(compare({ target: plank, previous: timedPrevious, draft: { loadGrams: null, reps: null, durationSeconds: 75, rir: null } }).lead).toBe("+15 s");
  });

  it("announces a load increase only on the untouched first suggested set", () => {
    const increase = liveProgression(live, ranged(squat, 6, 7), "kg");
    const draft = { loadGrams: 82_500, reps: 6, durationSeconds: null, rir: null };
    const base: SetDraft = { loadGrams: 82_500, reps: 6, durationSeconds: null, suggested: true };
    expect(compare({ progression: increase, draft, base }).lead).toBe("Haut de fourchette : +2,5 kg");
    expect(compare({ progression: increase, draft, base, setIndex: 1 }).lead).toBe("+2,5 kg · −2 rép.");
    expect(compare({ progression: increase, draft, base, editing: true }).lead).toBe("+2,5 kg · −2 rép.");
    expect(compare({ progression: increase, draft: { ...draft, reps: 7 }, base }).lead).toBe("+2,5 kg · −1 rép.");
  });

  it("marks a suspended progression with the hurting zones", () => {
    for (const level of ["discomfort", "stop"] as const) {
      const hurting = withPain(level);
      const suspended = liveProgression(hurting, ranged(squat, 6, 7), "kg");
      expect(compare({ progression: suspended, latestPains: hurting.latestPains })).toEqual({ mark: level, lead: "Progression suspendue · genou droit", previous: "préc. 80 × 8 · RIR 2" });
    }
  });
});
