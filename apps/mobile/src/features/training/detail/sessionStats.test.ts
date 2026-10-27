import { describe, expect, it } from "vitest";
import type { ExerciseLoad } from "@obnixe/core";
import type { EpochMs, Id, StrengthSet } from "@obnixe/schema";
import { bestSetIndex, setScores } from "@/features/training/detail/sessionStats";

interface SetValues {
  readonly loadGrams?: number | null;
  readonly reps?: number | null;
  readonly durationSeconds?: number | null;
  readonly interrupted?: boolean;
}

function set(position: number, values: SetValues): StrengthSet {
  return {
    id: `set-${position}` as Id,
    entryId: "entry" as Id,
    position,
    loadGrams: values.loadGrams ?? null,
    reps: values.reps ?? null,
    durationSeconds: values.durationSeconds ?? null,
    rir: null,
    restBeforeSeconds: null,
    interrupted: values.interrupted ?? false,
    completedAt: 0 as EpochMs,
  };
}

const barbell: ExerciseLoad = { loadMode: "total", baseGrams: null };
const dumbbells: ExerciseLoad = { loadMode: "per_hand", baseGrams: null };

describe("bestSetIndex", () => {
  it("picks the first set with the highest estimated max", () => {
    const sets = [set(0, { loadGrams: 75_000, reps: 5 }), set(1, { loadGrams: 75_000, reps: 6 }), set(2, { loadGrams: 75_000, reps: 6 }), set(3, { loadGrams: 80_000, reps: 2 })];
    expect(bestSetIndex(sets, barbell)).toBe(1);
  });

  it("ranks bodyweight sets by reps and timed sets by duration", () => {
    expect(bestSetIndex([set(0, { reps: 10 }), set(1, { reps: 12 })], barbell)).toBe(1);
    expect(bestSetIndex([set(0, { durationSeconds: 60 }), set(1, { durationSeconds: 45 })], barbell)).toBe(0);
  });

  it("ignores interrupted sets and needs two completed sets", () => {
    expect(bestSetIndex([set(0, { loadGrams: 20_000, reps: 8 }), set(1, { loadGrams: 40_000, interrupted: true })], dumbbells)).toBeNull();
    expect(bestSetIndex([set(0, { loadGrams: 20_000, reps: 8 }), set(1, { loadGrams: 40_000, interrupted: true }), set(2, { loadGrams: 20_000, reps: 10 })], dumbbells)).toBe(2);
  });
});

describe("setScores", () => {
  it("scores sets on the total load and zeroes interrupted ones", () => {
    expect(setScores([set(0, { loadGrams: 20_000, reps: 1 }), set(1, { loadGrams: 20_000, interrupted: true })], dumbbells)).toEqual([40_000, 0]);
  });
});
