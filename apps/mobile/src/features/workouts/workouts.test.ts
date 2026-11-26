import { describe, expect, it } from "vitest";
import { LiveTracker, resolveProfile, unfoldWorkout, workoutEstimate } from "@obnixe/core";
import type { RecorderState, ResolvedProfile, WorkoutView } from "@obnixe/core";
import { workoutLimits } from "@obnixe/schema";
import type { EpochMs, WorkoutPlan } from "@obnixe/schema";
import { notificationOf, workoutProgress } from "@/features/tracking/notification";
import { estimateText, workoutText } from "@/features/workouts/format";
import { absorbNext, appendRepeat, canAbsorbNext, canMove, defaultWorkout, durationOfKind, moveAt, removeAt, repeatStep, setCount, stepDuration, ungroup, workoutIssue } from "@/features/workouts/plan";

function profileOf(): ResolvedProfile {
  const profile = resolveProfile("run", {});
  if (profile === null) throw new Error("run records no track");
  return profile;
}

describe("workout text (WKT-001)", () => {
  it("writes the plan as the compact line of the spec", () => {
    expect(workoutText(defaultWorkout("pace"))).toBe("15 min · 8 × (400 m Z4 · 1:30 récup) · 10 min");
    expect(workoutText(defaultWorkout("speed"))).toBe("15 min · 6 × (5 min Z4 · 3 min récup) · 10 min");
    expect(workoutText(repeatStep({ version: 1, nodes: [{ type: "step", intent: "work", duration: { kind: "distance", mm: 1_250_000 }, target: { kind: "pace", fastestSecondsPerKm: 240, slowestSecondsPerKm: 250 }, label: null }] }, 0))).toBe(
      "2 × 1,25 km 4:00–4:10",
    );
  });

  it("estimates the plan in rounded kilometers and minutes", () => {
    expect(estimateText({ durationMs: 3_000_000, distanceMm: 10_400_000, complete: true })).toBe("≈ 10 km · 50 min");
    expect(estimateText({ durationMs: 0, distanceMm: 3_250_000, complete: false })).toBe("≈ 3,3 km");
    expect(estimateText({ durationMs: 0, distanceMm: 0, complete: false })).toBeNull();
    expect(estimateText(workoutEstimate(defaultWorkout("pace"), 3000))).toBe("≈ 9,9 km · 55 min");
  });
});

describe("workout plan editing (WKT-001)", () => {
  const plan = defaultWorkout("pace");

  it("steps durations on a grid finer for short steps, inside the limits", () => {
    expect(stepDuration({ kind: "time", ms: 90_000 }, 1)).toEqual({ kind: "time", ms: 105_000 });
    expect(stepDuration({ kind: "time", ms: 60_000 }, -1)).toEqual({ kind: "time", ms: 55_000 });
    expect(stepDuration({ kind: "time", ms: 62_000 }, -1)).toEqual({ kind: "time", ms: 60_000 });
    expect(stepDuration({ kind: "distance", mm: 400_000 }, 1)).toEqual({ kind: "distance", mm: 450_000 });
    expect(stepDuration({ kind: "distance", mm: 1_000_000 }, -1)).toEqual({ kind: "distance", mm: 950_000 });
    expect(stepDuration({ kind: "time", ms: workoutLimits.minTimeMs }, -1)).toEqual({ kind: "time", ms: workoutLimits.minTimeMs });
    expect(durationOfKind({ kind: "distance", mm: 1_000_000 }, "time", 4000)).toEqual({ kind: "time", ms: 255_000 });
  });

  it("removes, moves and regroups steps", () => {
    const withoutWork = removeAt(plan, { node: 1, step: 0 });
    expect(workoutText(withoutWork)).toBe("15 min · 8 × 1:30 récup · 10 min");
    expect(removeAt(withoutWork, { node: 1, step: 0 }).nodes).toHaveLength(2);
    expect(workoutText(moveAt(plan, { node: 1, step: 1 }, -1))).toBe("15 min · 8 × (1:30 récup · 400 m Z4) · 10 min");
    expect(canMove(plan, { node: 0, step: null }, -1)).toBe(false);
    expect(canMove(plan, { node: 1, step: 0 }, 1)).toBe(true);
    expect(canAbsorbNext(plan, 1)).toBe(true);
    expect(workoutText(absorbNext(plan, 1))).toBe("15 min · 8 × (400 m Z4 · 1:30 récup · 10 min)");
    expect(workoutText(ungroup(plan, 1))).toBe("15 min · 400 m Z4 · 1:30 récup · 10 min");
    expect(workoutText(setCount(appendRepeat(plan, "pace"), 3, 0))).toBe("15 min · 8 × (400 m Z4 · 1:30 récup) · 10 min · 1 × (1 km · 2 min récup)");
  });

  it("tells what keeps a plan from being used", () => {
    expect(workoutIssue(plan, "pace")).toBeNull();
    expect(workoutIssue({ version: 1, nodes: [] }, "pace")).toBe("Ajoute une étape.");
    expect(workoutIssue(defaultWorkout("speed"), "pace")).toBeNull();
    const speed: WorkoutPlan = { version: 1, nodes: [{ type: "step", intent: "work", duration: { kind: "time", ms: 60_000 }, target: { kind: "speed", minMmS: 8000, maxMmS: 9000 }, label: null }] };
    expect(workoutIssue(speed, "pace")).toBe("Une étape a une cible ou une durée hors limites.");
    expect(workoutIssue(setCount(setCount(appendRepeat(plan, "pace"), 3, workoutLimits.maxRepeat), 1, workoutLimits.maxRepeat), "pace")).toBe(`Au plus ${workoutLimits.maxSteps} étapes une fois les répétitions déroulées.`);
  });
});

describe("guided notification (REC-074, REC-075)", () => {
  const profile = profileOf();
  const steps = unfoldWorkout(defaultWorkout("pace"));
  const live = new LiveTracker(profile, null).snapshot(0);
  const view = (index: number | null, stepDistanceMm: number): WorkoutView => ({
    steps,
    started: true,
    current: index === null ? null : (steps[index] ?? null),
    next: index === null ? null : (steps[index + 1] ?? null),
    stepElapsedMs: 0,
    stepDistanceMm,
    remaining: index === null ? null : { kind: "distance", mm: 400_000 - stepDistanceMm },
    target: null,
    done: [],
  });
  const state: RecorderState = { phase: "recording", autoPause: false, motion: "moving", idleSince: null, pausedMs: 0, autoPausedMs: 0 };

  it("gives one segment per step, the work ones highlighted, filled up to the current step", () => {
    const progress = workoutProgress(view(1, 100_000));
    expect(progress.segments).toHaveLength(18);
    expect(progress.segments.filter((segment) => segment.highlighted)).toHaveLength(8);
    expect(progress.segments[1]).toEqual({ length: 100, highlighted: true });
    expect(progress.value).toBe(125);
    expect(workoutProgress(view(null, 0)).value).toBe(1800);
  });

  it("shows the current step in the text", () => {
    const notification = notificationOf(profile, state, live, 0 as EpochMs, null, view(1, 160_000));
    expect(notification.text).toBe("Étape 2/18 · Travail · reste 240 m");
    expect(notification.progress?.value).toBe(140);
    expect(notificationOf(profile, state, live, 0 as EpochMs, null, view(null, 0)).text).toBe("Séance terminée");
    expect(notificationOf(profile, state, live, 0 as EpochMs, null, null).progress).toBeNull();
  });
});
