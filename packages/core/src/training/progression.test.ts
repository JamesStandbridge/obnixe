import { describe, expect, it } from "vitest";
import type { Id } from "@obnixe/schema";
import { createTestContext } from "../testing.ts";
import { addExercise, apply, reload, seedProgram, startWorkout } from "./fixtures.ts";
import { finishMutations } from "./lifecycle.ts";
import { draftFor, previousPerformance, previousSetAt, suggestProgression } from "./progression.ts";
import type { PerformedSet, ProgressionRequest } from "./progression.ts";
import { logSetMutations } from "./sets.ts";
import { targetFor } from "./workout.ts";

const set = (kg: number | null, reps: number | null, rir: number | null, interrupted = false): PerformedSet => ({ loadGrams: kg === null ? null : kg * 1000, reps, durationSeconds: null, rir, interrupted });

const target = { ...targetFor(null, "load_reps"), sets: 3, repsMin: 6, repsMax: 10, rir: 2 };

function request(previous: readonly PerformedSet[], overrides: Partial<ProgressionRequest> = {}): ProgressionRequest {
  return { measure: "load_reps", target, stepGrams: 2500, previous, painful: false, ...overrides };
}

describe("suggestProgression", () => {
  it("starts from the bottom of the range without history", () => {
    const progression = suggestProgression(request([]));
    expect(progression.kind).toBe("first");
    expect(progression.sets).toHaveLength(3);
    expect(progression.sets[0]).toEqual({ loadGrams: 0, reps: 6, durationSeconds: null });
  });

  it("adds one load step and drops to the bottom of the range once every set reached the top", () => {
    const progression = suggestProgression(request([set(57.5, 10, 2), set(57.5, 10, 1), set(57.5, 10, 1)]));
    expect(progression.kind).toBe("increase_load");
    expect(progression.topReached).toBe(true);
    expect(progression.sets.every((suggestion) => suggestion.loadGrams === 60_000 && suggestion.reps === 6)).toBe(true);
  });

  it("suspends the load increase when a zone of the exercise hurts", () => {
    const progression = suggestProgression(request([set(57.5, 10, 2), set(57.5, 10, 2), set(57.5, 10, 2)], { painful: true }));
    expect(progression.kind).toBe("suspended");
    expect(progression.sets[0]).toEqual({ loadGrams: 57_500, reps: 10, durationSeconds: null });
  });

  it("does not progress when the top was reached far below the target reserve", () => {
    const progression = suggestProgression(request([set(57.5, 10, 0), set(57.5, 10, 0), set(57.5, 10, 0)]));
    expect(progression.kind).toBe("repeat");
  });

  it("adds a rep to sets that left more reserve than targeted", () => {
    const progression = suggestProgression(request([set(60, 9, 3), set(60, 8, 2), set(60, 7, 1)]));
    expect(progression.kind).toBe("add_reps");
    expect(progression.sets.map((suggestion) => suggestion.reps)).toEqual([10, 8, 7]);
  });

  it("repeats the last performance otherwise and ignores interrupted sets", () => {
    const progression = suggestProgression(request([set(82.5, 8, 2), set(82.5, 7, 1), set(82.5, null, null, true)]));
    expect(progression.kind).toBe("repeat");
    expect(progression.previous).toHaveLength(2);
    expect(progression.sets.map((suggestion) => suggestion.reps)).toEqual([8, 7, 7]);
    expect(previousSetAt(progression, 2)?.reps).toBe(7);
  });

  it("never adds load to bodyweight exercises", () => {
    const progression = suggestProgression(request([set(null, 10, 2), set(null, 10, 2), set(null, 10, 2)], { measure: "bodyweight_reps" }));
    expect(progression).toMatchObject({ kind: "repeat", topReached: true });
  });

  it("progresses timed holds by five seconds", () => {
    const timed = { ...targetFor(null, "duration"), sets: 2, durationMinSeconds: 30, durationMaxSeconds: 60, rir: 1 };
    const progression = suggestProgression({ measure: "duration", target: timed, stepGrams: null, previous: [{ loadGrams: null, reps: null, durationSeconds: 40, rir: 3, interrupted: false }], painful: false });
    expect(progression.kind).toBe("add_reps");
    expect(progression.sets[0]?.durationSeconds).toBe(45);
  });
});

describe("draftFor", () => {
  it("prefills from the previous set of the session, otherwise from the suggestion", () => {
    const progression = suggestProgression(request([set(57.5, 10, 2), set(57.5, 10, 2), set(57.5, 10, 2)]));
    expect(draftFor(progression, [], 0)).toEqual({ loadGrams: 60_000, reps: 6, durationSeconds: null, suggested: true });
    expect(draftFor(progression, [set(60, 8, 2)], 1)).toEqual({ loadGrams: 60_000, reps: 8, durationSeconds: null, suggested: false });
    expect(draftFor(progression, [set(60, null, null, true)], 1).suggested).toBe(true);
  });
});

describe("previousPerformance", () => {
  it("prefers the same program item lineage, then any session with the exercise", () => {
    const context = createTestContext();
    const squat = addExercise(context, { name: "Squat barre", measure: "load_reps", stepGrams: 2500, zones: [] });
    const program = seedProgram(context, [
      { name: "Séance A", sport: "strength", items: [{ exerciseId: squat, sets: 1, repsMin: 6, repsMax: 8, rir: 2, rest: 60, restAfter: 60 }] },
      { name: "Séance B", sport: "strength", items: [{ exerciseId: squat, sets: 1, repsMin: 10, repsMax: 12, rir: 2, rest: 60, restAfter: 60 }] },
    ]);
    const perform = (slotIndex: number, kg: number): Id => {
      const data = startWorkout(context, program, slotIndex);
      context.advance(60_000);
      apply(context, logSetMutations(data, { entryId: data.exercises[0]?.entry.id as Id, setId: context.env.newId(), values: { loadGrams: kg * 1000, reps: 8, durationSeconds: null, rir: 2 }, restBeforeSeconds: null, completedAt: context.env.now() }));
      apply(context, finishMutations(reload(context, data.session.id), context.env.now()));
      context.advance(86_400_000);
      return data.session.id;
    };
    const heavy = perform(0, 100);
    perform(1, 70);
    const current = startWorkout(context, program, 0);
    const lineage = current.exercises[0]?.item?.lineageId ?? null;
    const sameLineage = previousPerformance(context.db, { exerciseId: squat, itemLineageId: lineage, before: current.session.startedAt, excludeSessionId: current.session.id });
    expect(sameLineage?.sessionId).toBe(heavy);
    const anyLineage = previousPerformance(context.db, { exerciseId: squat, itemLineageId: null, before: current.session.startedAt, excludeSessionId: current.session.id });
    expect(anyLineage?.sets[0]?.loadGrams).toBe(70_000);
  });
});
