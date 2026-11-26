import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { lap, recording, workoutFitsMeasure, workoutPlanSchema, workoutPlanSchemaFor } from "@obnixe/schema";
import type { EpochMs, Id, WorkoutDuration, WorkoutIntent, WorkoutNode, WorkoutPlan, WorkoutStep, WorkoutTarget } from "@obnixe/schema";
import { fixtures } from "../data/testFixtures.ts";
import type { Fixtures } from "../data/testFixtures.ts";
import { createTestContext } from "../testing.ts";
import type { TestContext } from "../testing.ts";
import { IncompatibleWorkoutError, LapOutsideWorkoutError } from "../writer.ts";
import type { Mutation } from "../writer.ts";
import type { RecordingAlertEvent } from "./alerts.ts";
import { activityWindow, processTrack } from "./batch.ts";
import { decodeTrack, encodeTrack, trackDigest } from "./codec/track.ts";
import type { Track } from "./codec/track.ts";
import { LiveTracker } from "./live.ts";
import type { TrackerProgress } from "./live.ts";
import { planRecordingSave, planRecordingStart, planTrim, recordingStartMutations, variantWorkoutOf } from "./plans.ts";
import { profileOf, untrimmed } from "./testing/run.ts";
import { buildTruth, clearSky, move, simulate } from "./testing/scenarios.ts";
import type { Truth } from "./testing/scenarios.ts";
import { toSampleColumns } from "./types.ts";
import type { Sample, TrackerMark } from "./types.ts";
import { recordingLapSource, unfoldWorkout, workoutExtensionMs, workoutLapBounds, WorkoutRunner, workoutTargetTallies } from "./workout.ts";
import { lastWorkoutOf, recentSpeedOf, workoutEstimate, workoutReport } from "./workouts.ts";
import { heartRateZones } from "./zones.ts";

const none: WorkoutTarget = { kind: "none" };
const open: WorkoutDuration = { kind: "open" };
const seconds = (value: number): WorkoutDuration => ({ kind: "time", ms: value * 1000 });
const meters = (value: number): WorkoutDuration => ({ kind: "distance", mm: value * 1000 });
const step = (intent: WorkoutIntent, duration: WorkoutDuration, target: WorkoutTarget = none, label: string | null = null): WorkoutStep => ({ type: "step", intent, duration, target, label });
const repeat = (count: number, steps: readonly WorkoutStep[]): WorkoutNode => ({ type: "repeat", count, steps });
const plan = (...nodes: readonly WorkoutNode[]): WorkoutPlan => ({ version: 1, nodes });
const mark = (kind: TrackerMark["kind"], t: number): TrackerMark => ({ kind, t });

interface Timed {
  readonly t: number;
  readonly event: RecordingAlertEvent;
}

/** Fixes every `everyMs` from `fromMs` to `toMs` at a constant speed, with an optional constant heart rate. */
function drive(runner: WorkoutRunner, fromMs: number, toMs: number, distanceAt: (t: number) => number, heartRate: number | null = null, everyMs = 1000): Timed[] {
  const events: Timed[] = [];
  for (let t = fromMs; t <= toMs; t += everyMs) {
    const progress: TrackerProgress = { t, distanceMm: Math.round(distanceAt(t)), heartRate };
    for (const event of runner.push(progress)) events.push({ t, event });
  }
  return events;
}

const steady = (metersPerSecond: number) => (t: number): number => metersPerSecond * t;

function stepEvents(events: readonly Timed[]): (number | null)[] {
  return events.flatMap(({ event }) => (event.kind === "workout_step" ? [event.step?.index ?? null] : []));
}

describe("workoutPlanSchema (WKT-002)", () => {
  const intervals = plan(step("warmup", seconds(600)), repeat(8, [step("work", meters(400), { kind: "pace", fastestSecondsPerKm: 200, slowestSecondsPerKm: 215 }, "400"), step("recovery", seconds(90))]), step("cooldown", open));

  it("accepts a structured plan and counts its unfolded steps", () => {
    expect(workoutPlanSchema.parse(intervals)).toEqual(intervals);
    expect(unfoldWorkout(intervals)).toHaveLength(18);
  });

  it("refuses durations, repeats and plan sizes out of bounds", () => {
    expect(workoutPlanSchema.safeParse(plan(step("work", seconds(4)))).success).toBe(false);
    expect(workoutPlanSchema.safeParse(plan(step("work", seconds(6 * 3600 + 1)))).success).toBe(false);
    expect(workoutPlanSchema.safeParse(plan(step("work", meters(49)))).success).toBe(false);
    expect(workoutPlanSchema.safeParse(plan(step("work", meters(100_001)))).success).toBe(false);
    expect(workoutPlanSchema.safeParse(plan(repeat(51, [step("work", seconds(30))]))).success).toBe(false);
    expect(workoutPlanSchema.safeParse(plan(repeat(50, [step("work", seconds(30)), step("rest", seconds(30)), step("work", seconds(30)), step("rest", seconds(30))]))).success).toBe(true);
    expect(workoutPlanSchema.safeParse(plan(repeat(50, [step("work", seconds(30)), step("rest", seconds(30)), step("work", seconds(30)), step("rest", seconds(30))]), step("cooldown", open))).success).toBe(false);
    expect(workoutPlanSchema.safeParse(plan()).success).toBe(false);
    expect(workoutPlanSchema.safeParse({ version: 2, nodes: intervals.nodes }).success).toBe(false);
  });

  it("refuses a repeat inside a repeat, inverted spans and blank labels", () => {
    expect(workoutPlanSchema.safeParse({ version: 1, nodes: [{ type: "repeat", count: 2, steps: [repeat(2, [step("work", seconds(30))])] }] }).success).toBe(false);
    expect(workoutPlanSchema.safeParse(plan(step("work", seconds(60), { kind: "pace", fastestSecondsPerKm: 300, slowestSecondsPerKm: 240 }))).success).toBe(false);
    expect(workoutPlanSchema.safeParse(plan(step("work", seconds(60), { kind: "speed", minMmS: 9000, maxMmS: 8000 }))).success).toBe(false);
    expect(workoutPlanSchema.safeParse(plan(step("work", seconds(60), { kind: "heart_rate", minBpm: 170, maxBpm: 160 }))).success).toBe(false);
    expect(workoutPlanSchema.safeParse(plan(step("work", seconds(60), { kind: "heart_rate_zone", zone: 6 } as unknown as WorkoutTarget))).success).toBe(false);
    expect(workoutPlanSchema.safeParse(plan(step("work", seconds(60), none, "  "))).success).toBe(false);
  });

  it("matches pace targets to pace sports and speed targets to speed sports", () => {
    const pace = plan(step("work", seconds(60), { kind: "pace", fastestSecondsPerKm: 240, slowestSecondsPerKm: 270 }));
    const speed = plan(step("work", seconds(60), { kind: "speed", minMmS: 8000, maxMmS: 9000 }));
    const heart = plan(step("work", seconds(60), { kind: "heart_rate_zone", zone: 2 }));
    expect(workoutFitsMeasure(pace, "pace")).toBe(true);
    expect(workoutFitsMeasure(pace, "speed")).toBe(false);
    expect(workoutFitsMeasure(speed, "pace")).toBe(false);
    expect(workoutFitsMeasure(heart, "speed")).toBe(true);
    expect(workoutPlanSchemaFor("speed").safeParse(pace).success).toBe(false);
    expect(workoutPlanSchemaFor("speed").safeParse(speed).success).toBe(true);
  });
});

describe("unfoldWorkout", () => {
  it("writes out each repeat with the rank of every step", () => {
    const steps = unfoldWorkout(plan(step("warmup", seconds(600)), repeat(3, [step("work", meters(400)), step("recovery", seconds(90))]), step("cooldown", open)));
    expect(steps.map((run) => run.index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(steps.map((run) => run.intent)).toEqual(["warmup", "work", "recovery", "work", "recovery", "work", "recovery", "cooldown"]);
    expect(steps[0]?.repetition).toBeNull();
    expect(steps[3]?.repetition).toEqual({ number: 2, count: 3 });
    expect(steps[7]?.repetition).toBeNull();
  });
});

describe("workoutEstimate (WKT-001)", () => {
  const tenK = plan(
    step("warmup", meters(2000)),
    repeat(6, [step("work", meters(1000), { kind: "pace", fastestSecondsPerKm: 240, slowestSecondsPerKm: 250 }), step("recovery", seconds(120))]),
    step("cooldown", meters(2000)),
  );

  it("times distance steps at the middle of their pace target and the others at the recent speed", () => {
    expect(workoutEstimate(tenK, 3000)).toEqual({ durationMs: Math.round((4000 / 3) * 1000 + 6 * 245_000 + 720_000), distanceMm: 10_000_000 + 720 * 3000, complete: true });
  });

  it("leaves out what no speed tells without a recent speed, and open steps", () => {
    expect(workoutEstimate(tenK, null)).toEqual({ durationMs: 6 * 245_000 + 720_000, distanceMm: 10_000_000, complete: false });
    expect(workoutEstimate(plan(step("work", seconds(600), { kind: "speed", minMmS: 8000, maxMmS: 10_000 }), step("cooldown", open)), null)).toEqual({ durationMs: 600_000, distanceMm: 5_400_000, complete: false });
  });
});

describe("WorkoutRunner (WKT-003)", () => {
  it("counts time steps in chronometer time, manual pauses excluded", () => {
    const runner = new WorkoutRunner(plan(step("warmup", seconds(60)), step("work", seconds(30))), { heartRateZones: null });
    const events: Timed[] = runner.mark(mark("start", 0)).map((event) => ({ t: 0, event }));
    events.push(...drive(runner, 0, 25_000, steady(3)));
    runner.mark(mark("pause", 25_000));
    events.push(...drive(runner, 26_000, 34_000, () => 75_000));
    runner.mark(mark("resume", 35_000));
    events.push(...drive(runner, 35_000, 120_000, (t) => 75_000 + 3 * (t - 35_000)));
    expect(stepEvents(events)).toEqual([0, 1, null]);
    expect(runner.view(120_000).done).toEqual([
      { index: 0, startMs: 0, endMs: 70_000 },
      { index: 1, startMs: 70_000, endMs: 100_000 },
    ]);
    expect(runner.finished).toBe(true);
    expect(runner.lapBounds({ startMs: 0, endMs: 120_000 })).toEqual([
      { trigger: "workout", workoutStep: 0, startOffsetMs: 0, endOffsetMs: 70_000 },
      { trigger: "workout", workoutStep: 1, startOffsetMs: 70_000, endOffsetMs: 100_000 },
      { trigger: "manual", workoutStep: null, startOffsetMs: 100_000, endOffsetMs: 120_000 },
    ]);
  });

  it("lets a time step elapse while standing still, whatever the automatic pause", () => {
    const runner = new WorkoutRunner(plan(step("recovery", seconds(90)), step("work", seconds(60))), { heartRateZones: null });
    runner.mark(mark("start", 0));
    const events = drive(runner, 0, 100_000, () => 0);
    expect(stepEvents(events)).toEqual([1]);
    expect(runner.view(100_000).done).toEqual([{ index: 0, startMs: 0, endMs: 90_000 }]);
  });

  it("interpolates the crossing of a distance step and starts the next one exactly at its bound", () => {
    const runner = new WorkoutRunner(plan(step("work", meters(400)), step("recovery", meters(200))), { heartRateZones: null });
    runner.mark(mark("start", 0));
    const events = drive(runner, 0, 210_000, steady(3));
    expect(stepEvents(events)).toEqual([1, null]);
    const [first, second] = runner.view(210_000).done;
    expect(first?.endMs).toBeCloseTo(400_000 / 3, 3);
    expect(second?.endMs).toBeCloseTo(200_000, 3);
    expect(events.find(({ event }) => event.kind === "workout_step" && event.step?.index === 1)?.t).toBe(134_000);
    expect(runner.lapBounds({ startMs: 0, endMs: 210_000 }).map((bounds) => bounds.endOffsetMs)).toEqual([133_333, 200_000, 210_000]);
  });

  it("finds the same bounds whether ticks close the time steps between fixes or not", () => {
    const workout = plan(step("warmup", seconds(30)), step("work", meters(100)), step("recovery", seconds(20)));
    const distanceAt = steady(3);
    const run = (ticks: boolean): { readonly runner: WorkoutRunner; readonly events: Timed[] } => {
      const runner = new WorkoutRunner(workout, { heartRateZones: null });
      const events: Timed[] = [];
      runner.mark(mark("start", 0));
      for (let t = 0; t <= 120_000; t += 1000) {
        if (t % 5000 === 2000) for (const event of runner.push({ t, distanceMm: Math.round(distanceAt(t)), heartRate: null })) events.push({ t, event });
        if (ticks) for (const event of runner.advance(t)) events.push({ t, event });
      }
      return { runner, events };
    };
    const ticked = run(true);
    const batched = run(false);
    const window = { startMs: 0, endMs: 120_000 };
    expect(ticked.runner.lapBounds(window)).toEqual(batched.runner.lapBounds(window));
    expect(ticked.runner.view(120_000).done[1]?.endMs).toBeCloseTo(190_000 / 3, 3);
    expect(ticked.events.find(({ event }) => event.kind === "workout_step" && event.step?.index === 1)?.t).toBe(30_000);
    expect(batched.events.find(({ event }) => event.kind === "workout_step" && event.step?.index === 1)?.t).toBe(32_000);
  });

  it("ends an open step, or any step early, with a lap mark and splits the time after the plan at the manual laps", () => {
    const runner = new WorkoutRunner(plan(step("warmup", open), step("work", seconds(30)), step("cooldown", seconds(10))), { heartRateZones: null });
    runner.mark(mark("start", 0));
    drive(runner, 0, 19_000, steady(3));
    expect(stepEvents(runner.mark(mark("lap", 20_000)).map((event) => ({ t: 20_000, event })))).toEqual([1]);
    drive(runner, 20_000, 34_000, steady(3));
    runner.mark(mark("lap", 35_000));
    drive(runner, 35_000, 50_000, steady(3));
    runner.mark(mark("lap", 55_000));
    drive(runner, 55_000, 60_000, steady(3));
    runner.mark(mark("stop", 60_000));
    expect(runner.lapBounds({ startMs: 0, endMs: 60_000 })).toEqual([
      { trigger: "workout", workoutStep: 0, startOffsetMs: 0, endOffsetMs: 20_000 },
      { trigger: "workout", workoutStep: 1, startOffsetMs: 20_000, endOffsetMs: 35_000 },
      { trigger: "workout", workoutStep: 2, startOffsetMs: 35_000, endOffsetMs: 45_000 },
      { trigger: "manual", workoutStep: null, startOffsetMs: 45_000, endOffsetMs: 55_000 },
      { trigger: "manual", workoutStep: null, startOffsetMs: 55_000, endOffsetMs: 60_000 },
    ]);
  });

  it("stores an unfinished step up to the end of the activity", () => {
    const runner = new WorkoutRunner(plan(step("work", seconds(60)), step("recovery", seconds(60))), { heartRateZones: null });
    runner.mark(mark("start", 0));
    drive(runner, 0, 90_000, steady(3));
    runner.mark(mark("stop", 90_000));
    expect(runner.lapBounds({ startMs: 0, endMs: 90_000 })).toEqual([
      { trigger: "workout", workoutStep: 0, startOffsetMs: 0, endOffsetMs: 60_000 },
      { trigger: "workout", workoutStep: 1, startOffsetMs: 60_000, endOffsetMs: 90_000 },
    ]);
  });

  it("adds a minute to a time step for each extend mark, none to a distance step or once the plan is done (WKT-004)", () => {
    const runner = new WorkoutRunner(plan(step("recovery", seconds(60)), step("work", meters(200)), step("cooldown", seconds(30))), { heartRateZones: null });
    runner.mark(mark("start", 0));
    drive(runner, 0, 30_000, () => 0);
    runner.mark(mark("extend", 30_500));
    expect(runner.view(31_000)).toMatchObject({ extendable: true, extendedMs: workoutExtensionMs, remaining: { kind: "time", ms: 89_000 } });
    expect(stepEvents(drive(runner, 31_000, 125_000, () => 0))).toEqual([1]);
    expect(runner.view(125_000)).toMatchObject({ current: { index: 1 }, extendable: false, extendedMs: 0 });
    runner.mark(mark("extend", 125_500));
    expect(runner.view(126_000).extendedMs).toBe(0);
    drive(runner, 126_000, 240_000, (t) => 4 * (t - 126_000));
    runner.mark(mark("extend", 240_500));
    expect(runner.view(241_000)).toMatchObject({ current: null, extendable: false, extendedMs: 0 });
    expect(runner.view(241_000).done.map((span) => span.endMs)).toEqual([120_000, 176_000, 206_000]);
  });

  it("finds an extended step again when replaying its track (WKT-003, WKT-004)", () => {
    const workout = plan(step("warmup", seconds(60)), step("work", seconds(30)), step("cooldown", open));
    const { samples } = simulate(buildTruth({ latitude: 45.1885, longitude: 5.7245, altitude: 214, legs: [move(900, 3, 0)] }), clearSky, 5);
    const endT = samples.at(-1)?.t ?? 0;
    const marks = [mark("start", 0), mark("extend", 20_000), mark("extend", 40_000), mark("stop", endT)];
    const track = decodeTrack(encodeTrack({ startedAt: 1_780_000_000_000 as EpochMs, samples: toSampleColumns(samples), marks }));
    expect(track.marks).toEqual(marks);
    expect(workoutLapBounds(track, profileOf({ sport: "run" }), workout).map((bounds) => bounds.endOffsetMs)).toEqual([180_000, 210_000, endT]);
  });

  it("shows the current step, what remains of it and the next one (WKT-004)", () => {
    const runner = new WorkoutRunner(plan(step("warmup", seconds(60)), step("work", meters(400), { kind: "pace", fastestSecondsPerKm: 240, slowestSecondsPerKm: 270 })), { heartRateZones: null });
    expect(runner.view(0)).toMatchObject({ started: false, current: { index: 0 }, next: { index: 1 }, stepElapsedMs: 0 });
    runner.mark(mark("start", 0));
    drive(runner, 0, 40_000, steady(4));
    expect(runner.view(40_500)).toMatchObject({ started: true, current: { index: 0 }, stepElapsedMs: 40_500, remaining: { kind: "time", ms: 19_500 }, target: null });
    drive(runner, 41_000, 85_000, steady(4));
    const view = runner.view(85_000);
    expect(view).toMatchObject({ current: { index: 1 }, next: null, stepDistanceMm: 100_000, remaining: { kind: "distance", mm: 300_000 } });
    expect(view.target?.value).toBeCloseTo(4, 3);
    expect(view.target?.position).toBe("inside");
    drive(runner, 86_000, 170_000, steady(4));
    expect(runner.view(170_000)).toMatchObject({ current: null, next: null, remaining: null });
  });
});

describe("WorkoutRunner targets (WKT-005)", () => {
  const targetEvents = (events: readonly Timed[]): { readonly t: number; readonly status: string }[] =>
    events.flatMap(({ t, event }) => (event.kind === "workout_target" ? [{ t, status: event.status }] : []));

  it("leaves a work step 20 s to settle, then signals 8 s out of the span and 4 s back in it", () => {
    const runner = new WorkoutRunner(plan(step("work", seconds(180), { kind: "pace", fastestSecondsPerKm: 240, slowestSecondsPerKm: 270 })), { heartRateZones: null });
    runner.mark(mark("start", 0));
    const slow = drive(runner, 0, 60_000, steady(3));
    const fast = drive(runner, 61_000, 120_000, (t) => 180_000 + 3.9 * (t - 60_000));
    const signalled = targetEvents([...slow, ...fast]);
    expect(signalled[0]).toEqual({ t: 28_000, status: "below" });
    const back = signalled.find((event) => event.status === "back");
    expect(back?.t).toBeGreaterThanOrEqual(64_000);
    expect(back?.t).toBeLessThanOrEqual(74_000);
  });

  it("watches a recovery step from its start, on the heart rate averaged over 5 s", () => {
    const runner = new WorkoutRunner(plan(step("recovery", seconds(120), { kind: "heart_rate", minBpm: 120, maxBpm: 140 })), { heartRateZones: null });
    runner.mark(mark("start", 0));
    const events = drive(runner, 0, 30_000, steady(2), 160);
    expect(targetEvents(events)[0]).toEqual({ t: 8000, status: "above" });
    expect(runner.view(30_000).target).toEqual({ bounds: { low: 120, high: 140 }, value: 160, position: "above" });
  });

  it("ignores the margin of the tolerance and resets at each step", () => {
    const runner = new WorkoutRunner(plan(step("recovery", seconds(20), { kind: "heart_rate", minBpm: 120, maxBpm: 140 }), step("recovery", seconds(60), { kind: "heart_rate", minBpm: 150, maxBpm: 170 })), { heartRateZones: null });
    runner.mark(mark("start", 0));
    expect(targetEvents(drive(runner, 0, 19_000, steady(2), 141))).toEqual([]);
    const events = drive(runner, 20_000, 40_000, steady(2), 141);
    expect(targetEvents(events)[0]).toEqual({ t: 28_000, status: "below" });
  });

  it("watches heart-rate zones only with a maximum heart rate", () => {
    const zoned = plan(step("recovery", seconds(120), { kind: "heart_rate_zone", zone: 2 }));
    const blind = new WorkoutRunner(zoned, { heartRateZones: null });
    blind.mark(mark("start", 0));
    expect(targetEvents(drive(blind, 0, 30_000, steady(2), 185))).toEqual([]);
    expect(blind.view(30_000).target).toEqual({ bounds: null, value: 185, position: null });
    const watched = new WorkoutRunner(zoned, { heartRateZones: heartRateZones(190) });
    watched.mark(mark("start", 0));
    expect(targetEvents(drive(watched, 0, 30_000, steady(2), 185))[0]).toEqual({ t: 8000, status: "above" });
  });

  it("does not watch the target during a manual pause", () => {
    const runner = new WorkoutRunner(plan(step("recovery", seconds(120), { kind: "heart_rate", minBpm: 120, maxBpm: 140 })), { heartRateZones: null });
    runner.mark(mark("start", 0));
    drive(runner, 0, 5000, steady(2), 160);
    runner.mark(mark("pause", 5500));
    expect(targetEvents(drive(runner, 6000, 30_000, () => 10_000, 160))).toEqual([]);
  });
});

const intervalsWorkout = plan(
  step("warmup", meters(1000)),
  repeat(5, [step("work", meters(400), { kind: "pace", fastestSecondsPerKm: 170, slowestSecondsPerKm: 190 }), step("recovery", meters(200))]),
  step("cooldown", open),
);

interface Intervals {
  readonly truth: Truth;
  readonly samples: readonly Sample[];
  readonly marks: readonly TrackerMark[];
  readonly track: Track;
}

function intervalsRun(seed: number): Intervals {
  const legs = [move(1000, 2.8, 0), ...Array.from({ length: 5 }, (_, index) => [move(400, 1000 / 180, 90 + index * 20), move(200, 2.2, 270 + index * 20)]).flat(), move(800, 2.8, 180)];
  const truth = buildTruth({ latitude: 45.1885, longitude: 5.7245, altitude: 214, legs });
  const { samples } = simulate(truth, clearSky, seed);
  const endT = samples.at(-1)?.t ?? 0;
  const marks = [mark("start", 0), mark("stop", endT)];
  return { truth, samples, marks, track: { startedAt: 1_780_000_000_000 as EpochMs, samples: toSampleColumns(samples), marks } };
}

function truthDistanceAt(truth: Truth, t: number): number {
  let distance = 0;
  for (let index = 1; index < truth.length && (truth.t[index] ?? 0) <= t; index += 1) distance += ((truth.speed[index] ?? 0) * ((truth.t[index] ?? 0) - (truth.t[index - 1] ?? 0))) / 1000;
  return distance;
}

describe("guided recording replay (WKT-003, WKT-006, WKT-007)", () => {
  const run = intervalsRun(11);
  const profile = profileOf({ sport: "run" });

  it("stores exactly the bounds the live runner found, and a replay finds them again", () => {
    const tracker = new LiveTracker(profile, null);
    const runner = new WorkoutRunner(intervalsWorkout, { heartRateZones: null });
    let markIndex = 0;
    for (const sample of run.samples) {
      for (; markIndex < run.marks.length && (run.marks[markIndex]?.t ?? 0) <= sample.t; markIndex += 1) {
        const next = run.marks[markIndex] as TrackerMark;
        tracker.mark(next);
        runner.mark(next);
      }
      tracker.push(sample);
      if (sample.type === "fix") runner.push(tracker.progress(sample.t));
    }
    for (; markIndex < run.marks.length; markIndex += 1) {
      tracker.mark(run.marks[markIndex] as TrackerMark);
      runner.mark(run.marks[markIndex] as TrackerMark);
    }
    const stored = workoutLapBounds(run.track, profile, intervalsWorkout);
    expect(runner.lapBounds(activityWindow(run.track.samples, run.track.marks, untrimmed))).toEqual(stored);
    expect(workoutLapBounds(run.track, profile, intervalsWorkout)).toEqual(stored);
    expect(stored.map((bounds) => bounds.workoutStep)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    expect(stored.every((bounds) => bounds.trigger === "workout")).toBe(true);
  });

  it("makes one lap per step with the distance of the step", () => {
    const processed = processTrack(run.track, profile, { laps: recordingLapSource(run.track, profile, null, intervalsWorkout), trim: untrimmed });
    expect(processed.laps).toHaveLength(12);
    const work = processed.laps.filter((_, index) => index % 2 === 1 && index < 11);
    for (const summary of work) expect(Math.abs(summary.distanceMm - 400_000)).toBeLessThan(8000);
    expect(Math.abs((processed.laps[0]?.distanceMm ?? 0) - 1_000_000)).toBeLessThan(20_000);
  });

  it("reports each step with its time in the target and summarizes the work repetitions (WKT-007)", () => {
    const processed = processTrack(run.track, profile, { laps: recordingLapSource(run.track, profile, null, intervalsWorkout), trim: untrimmed });
    const tallies = workoutTargetTallies(run.track, profile, intervalsWorkout, { heartRateZones: null });
    expect(tallies).toHaveLength(12);
    expect(tallies[0]).toEqual({ judgedMs: 0, insideMs: 0 });
    const report = workoutReport(intervalsWorkout, processed.laps, tallies);
    expect(report.rows.map((row) => row.step.index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    expect(report.rows.filter((row) => row.step.intent !== "work").every((row) => row.inTargetPermille === null)).toBe(true);
    const work = report.rows.filter((row) => row.step.intent === "work");
    expect(work.every((row) => (tallies[row.step.index]?.judgedMs ?? 0) > 60_000 && (row.inTargetPermille ?? 0) > 400)).toBe(true);
    expect(work.reduce((sum, row) => sum + (row.inTargetPermille ?? 0), 0) / work.length).toBeGreaterThan(650);
    expect(report.work?.count).toBe(5);
    expect(Math.abs((report.work?.distanceMm ?? 0) - 2_000_000)).toBeLessThan(30_000);
    expect(report.work?.fastestMmS).toBeGreaterThanOrEqual(report.work?.slowestMmS ?? Number.POSITIVE_INFINITY);
    expect(workoutReport(plan(step("work", seconds(60))), processed.laps.slice(0, 1), tallies.slice(0, 1)).work).toBeNull();
  });

  it("signals the end of a 400 m repetition at 3:00 /km less than 8 m after its bound with one batch per second", () => {
    const tracker = new LiveTracker(profile, null);
    const runner = new WorkoutRunner(intervalsWorkout, { heartRateZones: null });
    runner.mark(mark("start", 0));
    tracker.mark(mark("start", 0));
    const arrivals: { readonly index: number; readonly t: number }[] = [];
    for (const sample of run.samples) {
      tracker.push(sample);
      if (sample.type !== "fix") continue;
      for (const event of runner.push(tracker.progress(sample.t))) if (event.kind === "workout_step" && event.step !== null) arrivals.push({ index: event.step.index, t: sample.t });
    }
    const spans = runner.view(run.samples.at(-1)?.t ?? 0).done;
    const repetitionEnds = arrivals.filter((arrival) => arrival.index % 2 === 0 && arrival.index > 0 && arrival.index < 11);
    expect(repetitionEnds).toHaveLength(5);
    for (const arrival of repetitionEnds) {
      const span = spans[arrival.index - 1];
      expect(span).toBeDefined();
      expect(truthDistanceAt(run.truth, arrival.t) - truthDistanceAt(run.truth, span?.endMs ?? 0)).toBeLessThan(8);
    }
  });
});

describe("guided recordings in the journal (WKT-007, WKT-009)", () => {
  let context: TestContext;
  let make: Fixtures;
  const startedAt = Date.UTC(2026, 10, 2, 7, 30) as EpochMs;

  beforeEach(() => {
    context = createTestContext();
    make = fixtures(context);
  });

  function slotWithVariant(sport: "run" | "bike", workout: WorkoutPlan | null): { readonly slotId: Id; readonly variantId: Id; readonly mutations: readonly Mutation[] } {
    const program = make.program("active");
    const version = make.version(program.id, 1, "Prépa");
    const slotId = context.env.newId();
    const variantId = context.env.newId();
    return {
      slotId,
      variantId,
      mutations: [
        { kind: "insert", table: "program", row: program },
        { kind: "insert", table: "program_version", row: version },
        { kind: "insert", table: "program_slot", row: { id: slotId, versionId: version.id, lineageId: "intervals" as Id, position: 0, sport, name: "Fractionné", targetDurationSeconds: null, targetEffort: null, targetValues: {} } },
        { kind: "insert", table: "program_variant", row: { id: variantId, slotId, lineageId: "track" as Id, position: 0, name: "Piste", workout } },
      ],
    };
  }

  it("keeps the workout of a variant whose sport measures its targets", () => {
    const slot = slotWithVariant("run", intervalsWorkout);
    make.write(slot.mutations);
    expect(variantWorkoutOf(context.db, slot.variantId)).toEqual(intervalsWorkout);
  });

  it("refuses a pace workout on a speed sport, and a slot moved to one", () => {
    expect(() => make.write(slotWithVariant("bike", intervalsWorkout).mutations)).toThrow(IncompatibleWorkoutError);
    const slot = slotWithVariant("run", intervalsWorkout);
    make.write(slot.mutations);
    expect(() => make.write([{ kind: "update", table: "program_slot", key: slot.slotId, patch: { sport: "bike" } }])).toThrow(IncompatibleWorkoutError);
    expect(() => make.write([{ kind: "update", table: "program_variant", key: slot.variantId, patch: { workout: { version: 1, nodes: [] } as unknown as WorkoutPlan } }])).toThrow(ZodError);
  });

  it("refuses a recording start whose workout does not fit the sport", () => {
    const speed = plan(step("work", seconds(60), { kind: "speed", minMmS: 8000, maxMmS: 9000 }));
    expect(() => planRecordingStart(context.db, context.env, { sport: "run", values: {}, gearId: null, slot: null, timeZone: "Europe/Paris", routeId: null, workout: speed, stopwatch: false })).toThrow(ZodError);
  });

  it("freezes the workout in the recording and saves one lap per step", () => {
    const slot = slotWithVariant("run", intervalsWorkout);
    make.write(slot.mutations);
    const workout = variantWorkoutOf(context.db, slot.variantId);
    const started = planRecordingStart(context.db, context.env, { sport: "run", values: {}, gearId: null, slot: { slotId: slot.slotId, variantId: slot.variantId, countsInRotation: true }, timeZone: "Europe/Paris", routeId: null, workout, stopwatch: false });
    make.write(recordingStartMutations(started, { startedAt, device: "Pixel 9 Pro" }));
    make.write([{ kind: "update", table: "program_variant", key: slot.variantId, patch: { workout: plan(step("work", seconds(600))) } }]);
    const row = () => context.db.select().from(recording).where(eq(recording.sessionId, started.sessionId)).get();
    expect(row()?.workout).toEqual(intervalsWorkout);

    const run = intervalsRun(5);
    const track: Track = { ...run.track, startedAt };
    const processed = processTrack(track, started.profile, { laps: recordingLapSource(track, started.profile, null, row()?.workout ?? null), trim: untrimmed });
    const bytes = encodeTrack(track);
    make.write(planRecordingSave(context.db, context.env, { sessionId: started.sessionId, track, processed, stored: { file: `tracks/${started.recordingId}.otrk`, sha256: trackDigest(bytes), bytes: bytes.length }, pains: [] }));
    expect(lastWorkoutOf(context.db, "run")).toEqual(intervalsWorkout);
    expect(lastWorkoutOf(context.db, "bike")).toBeNull();
    const saved = row();
    expect(recentSpeedOf(context.db, "run")).toBeCloseTo(((saved?.distanceMm ?? 0) / (saved?.movingMs ?? 1)) * 1000, 6);
    expect(recentSpeedOf(context.db, "bike")).toBeNull();
    const laps = context.db.select().from(lap).where(eq(lap.sessionId, started.sessionId)).all();
    expect(laps.map((stored) => stored.workoutStep)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    expect(laps.every((stored) => stored.trigger === "workout")).toBe(true);
    expect(laps.map((stored) => ({ trigger: stored.trigger, startOffsetMs: stored.startOffsetMs, endOffsetMs: stored.endOffsetMs, workoutStep: stored.workoutStep }))).toEqual(
      workoutLapBounds(track, started.profile, intervalsWorkout).map((bounds, index, all) => (index === all.length - 1 ? { ...bounds, endOffsetMs: processed.elapsed.endMs } : bounds)),
    );

    const trimmed = planTrim(context.db, context.env, started.sessionId, track, { startMs: 30_000, endMs: null });
    expect(trimmed.processed.laps.map((summary) => summary.bounds.workoutStep)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    make.write(trimmed.mutations);
  });

  it("refuses workout laps without a workout or beyond its steps", () => {
    const started = planRecordingStart(context.db, context.env, { sport: "run", values: {}, gearId: null, slot: null, timeZone: "Europe/Paris", routeId: null, workout: plan(step("work", seconds(60)), step("recovery", seconds(60))), stopwatch: false });
    make.write(recordingStartMutations(started, { startedAt, device: "Pixel 9 Pro" }));
    make.write([{ kind: "update", table: "recording", key: started.recordingId, patch: { elapsedMs: 120_000 } }]);
    const lapRow = (workoutStep: number) => ({ id: context.env.newId(), sessionId: started.sessionId, position: 0, trigger: "workout" as const, startOffsetMs: 0, endOffsetMs: 60_000, workoutStep });
    expect(() => make.write([{ kind: "insert", table: "lap", row: lapRow(2) }])).toThrow(LapOutsideWorkoutError);
    make.write([{ kind: "insert", table: "lap", row: lapRow(1) }]);
    expect(() => make.write([{ kind: "update", table: "recording", key: started.recordingId, patch: { workout: plan(step("work", seconds(60))) } }])).toThrow(LapOutsideWorkoutError);
    expect(() => make.write([{ kind: "update", table: "recording", key: started.recordingId, patch: { workout: null } }])).toThrow(LapOutsideWorkoutError);
  });
});
