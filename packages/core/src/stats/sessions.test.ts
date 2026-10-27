import { beforeEach, describe, expect, it } from "vitest";
import { createTestContext } from "../testing.ts";
import { completedSessions } from "./sessions.ts";
import { Seeder } from "./testing.ts";

let seed: Seeder;

beforeEach(() => {
  seed = new Seeder(createTestContext());
});

describe("strength digest", () => {
  it("sums completed sets and volume per exercise in session order, honoring load modes", () => {
    const squat = seed.exercise("Squat barre");
    const curl = seed.exercise("Curl haltères", "load_reps", [], { loadMode: "per_hand", baseGrams: null });
    const press = seed.exercise("Développé EZ", "load_reps", [], { loadMode: "per_side", baseGrams: 10_000 });
    seed.session({
      sport: "strength",
      date: "2026-10-20",
      entries: [
        { exerciseId: squat, sets: [{ kg: 70, reps: 5 }, { kg: 75, reps: 5 }, { kg: 75, reps: 4 }, { kg: 80, reps: 2, interrupted: true }] },
        { exerciseId: curl, sets: [{ kg: 12, reps: 10 }, { kg: 12, reps: 12 }] },
        { exerciseId: press, sets: [{ kg: 15, reps: 8 }] },
      ],
    });
    const strength = completedSessions(seed.context.db)[0]?.strength;
    expect(strength?.sets).toBe(6);
    expect(strength?.exercises).toEqual([
      { name: "Squat barre", sets: 3, volumeGrams: 70_000 * 5 + 75_000 * 5 + 75_000 * 4, topLoadGrams: 75_000, topReps: 5, topDurationSeconds: null },
      { name: "Curl haltères", sets: 2, volumeGrams: 24_000 * 22, topLoadGrams: 24_000, topReps: 12, topDurationSeconds: null },
      { name: "Développé EZ", sets: 1, volumeGrams: 40_000 * 8, topLoadGrams: 40_000, topReps: 8, topDurationSeconds: null },
    ]);
    expect(strength?.volumeGrams).toBe(1_025_000 + 528_000 + 320_000);
  });

  it("keeps bodyweight and timed sets without volume and leaves other sessions without a digest", () => {
    const pullUp = seed.exercise("Tractions", "bodyweight_reps");
    const plank = seed.exercise("Gainage", "duration");
    seed.session({ sport: "strength", date: "2026-10-20", entries: [{ exerciseId: pullUp, sets: [{ kg: null, reps: 6 }, { kg: null, reps: 8 }] }, { exerciseId: plank, sets: [{ kg: null, seconds: 45 }, { kg: null, seconds: 60 }] }] });
    seed.session({ sport: "strength", date: "2026-10-21", entries: [{ exerciseId: pullUp, sets: [{ kg: null, reps: 3, interrupted: true }] }] });
    seed.session({ sport: "run", date: "2026-10-22", values: { kind: "easy", distance: 5000 } });
    const [bodyweight, interrupted, run] = completedSessions(seed.context.db);
    expect(bodyweight?.strength).toEqual({
      sets: 4,
      volumeGrams: 0,
      exercises: [
        { name: "Tractions", sets: 2, volumeGrams: 0, topLoadGrams: null, topReps: 8, topDurationSeconds: null },
        { name: "Gainage", sets: 2, volumeGrams: 0, topLoadGrams: null, topReps: null, topDurationSeconds: 60 },
      ],
    });
    expect(interrupted?.strength).toBeNull();
    expect(run?.strength).toBeNull();
    expect(run?.timeZone).toBe("Europe/Paris");
  });
});
