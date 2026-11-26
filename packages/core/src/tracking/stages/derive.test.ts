import { describe, expect, it } from "vitest";
import { runProfile } from "@obnixe/schema";
import { createRandom } from "../testing/random.ts";
import { heartRateColumns } from "../testing/fixes.ts";
import { SpanOverlap, forEachHeartRateSpan } from "../zones.ts";
import {
  accumulateHeartRate,
  AutoLapper,
  bestAscentEffort,
  bestDistanceEffort,
  bestEffortPauseLimitMs,
  effortSections,
  intervalCodes,
  intervalKind,
  isCountedCode,
  locate,
  locateTime,
  maxWindowSpeed,
  motionIntervals,
  countedSpans,
  PauseLedger,
  recordedLapBounds,
  SpeedSmoother,
  splitsOf,
  summarizeLaps,
  valueAt,
} from "./derive.ts";
import type { MotionIntervalKind, TrackSeries } from "./derive.ts";
import type { TimeSpan } from "../zones.ts";

interface Step {
  readonly durationMs: number;
  readonly meters: number;
  readonly kind: MotionIntervalKind;
  readonly climb?: number;
}

/** A series from interval steps, starting at `t = 0` with every cumulative column at 0. */
function seriesOf(steps: readonly Step[]): TrackSeries {
  const length = steps.length + 1;
  const t = new Float64Array(length);
  const interval = new Uint8Array(length);
  const distance = new Float64Array(length);
  const moving = new Float64Array(length);
  const ascent = new Float64Array(length);
  steps.forEach((step, index) => {
    const counted = isCountedCode(intervalCodes[step.kind]);
    t[index + 1] = (t[index] ?? 0) + step.durationMs;
    interval[index + 1] = intervalCodes[step.kind];
    distance[index + 1] = (distance[index] ?? 0) + (counted ? step.meters : 0);
    moving[index + 1] = (moving[index] ?? 0) + (counted ? step.durationMs : 0);
    ascent[index + 1] = (ascent[index] ?? 0) + (counted ? (step.climb ?? 0) : 0);
  });
  return {
    length,
    t,
    fixIndex: Uint32Array.from({ length }, (_, index) => index),
    latitude: new Float64Array(length),
    longitude: new Float64Array(length),
    speed: Float32Array.from({ length }, (_, index) => (index === 0 ? 0 : (steps[index - 1]?.meters ?? 0) / ((steps[index - 1]?.durationMs ?? 1) / 1000))),
    altitude: new Float32Array(length),
    grade: new Float64Array(length).fill(Number.NaN),
    interval,
    distance,
    moving,
    ascent,
    descent: new Float64Array(length),
    gradeAdjustedDistance: null,
    steps: null,
    heartBeats: null,
    heartRateMs: null,
  };
}

function randomSteps(seed: number, count: number): Step[] {
  const random = createRandom(seed);
  const steps: Step[] = [];
  for (let index = 0; index < count; index += 1) {
    const roll = random.uniform();
    if (roll < 0.04) steps.push({ durationMs: random.between(20_000, 600_000), meters: 0, kind: "paused" });
    else if (roll < 0.06) steps.push({ durationMs: random.between(11_000, 400_000), meters: 0, kind: "gap" });
    else if (roll < 0.12) steps.push({ durationMs: 1000, meters: random.uniform(), kind: "stopped" });
    else if (roll < 0.14) steps.push({ durationMs: random.between(11_000, 60_000), meters: random.between(20, 200), kind: "bridged" });
    else steps.push({ durationMs: random.between(500, 3000), meters: random.between(0.5, 12), kind: "moving", climb: random.between(-1, 3) });
  }
  return steps;
}

/** Pauses of the series as spans, the way the journal marks would bound them. */
function pausesOf(series: TrackSeries): TimeSpan[] {
  return motionIntervals(series).filter((interval) => interval.kind === "paused").map(({ startMs, endMs }) => ({ startMs, endMs }));
}

function blocked(series: TrackSeries, pauses: readonly TimeSpan[], index: number): boolean {
  if (series.interval[index] === intervalCodes.gap) return true;
  const end = series.t[index] ?? 0;
  return series.interval[index] === intervalCodes.paused && pauses.some((pause) => pause.endMs - pause.startMs > bestEffortPauseLimitMs && end > pause.startMs && end <= pause.endMs);
}

/** O(n^2): every end, the start interpolated at `d(end) - meters`, every interval of the window checked. */
function exhaustiveDistanceEffort(series: TrackSeries, pauses: readonly TimeSpan[], meters: number): { elapsed: number; start: number } | null {
  let best: { elapsed: number; start: number } | null = null;
  for (let end = 1; end < series.length; end += 1) {
    const target = (series.distance[end] ?? 0) - meters;
    if (target < 0) continue;
    for (let first = 1; first <= end; first += 1) {
      const low = series.distance[first - 1] ?? 0;
      const high = series.distance[first] ?? 0;
      if (!(low <= target && target < high)) continue;
      let eligible = true;
      for (let index = first; index <= end; index += 1) if (blocked(series, pauses, index)) eligible = false;
      if (!eligible) continue;
      const start = valueAt(series.t, first - 1 + (target - low) / (high - low));
      const elapsed = (series.t[end] ?? 0) - start;
      if (best === null || elapsed < best.elapsed) best = { elapsed, start };
    }
  }
  return best;
}

describe("interval kinds (GPS-033, GPS-040)", () => {
  const facts = { durationMs: 1000, meters: 3, restart: false, paused: false, moving: true };

  it("lets a manual pause win and follows the classifier otherwise", () => {
    expect(intervalKind({ ...facts, paused: true, durationMs: 60_000 }, runProfile)).toBe("paused");
    expect(intervalKind(facts, runProfile)).toBe("moving");
    expect(intervalKind({ ...facts, moving: false }, runProfile)).toBe("stopped");
  });

  it("bridges short gaps and restarts at a plausible speed, leaves the others unfilled", () => {
    expect(intervalKind({ ...facts, durationMs: 90_000, meters: 270 }, runProfile)).toBe("bridged");
    expect(intervalKind({ ...facts, durationMs: 10_000, meters: 0, moving: false }, runProfile)).toBe("stopped");
    expect(intervalKind({ ...facts, durationMs: 10_001, meters: 1, moving: false }, runProfile)).toBe("gap");
    expect(intervalKind({ ...facts, durationMs: 181_000, meters: 600 }, runProfile)).toBe("gap");
    expect(intervalKind({ ...facts, durationMs: 20_000, meters: 300 }, runProfile)).toBe("gap");
    expect(intervalKind({ ...facts, restart: true, meters: 3 }, runProfile)).toBe("bridged");
    expect(intervalKind({ ...facts, restart: true, meters: 400 }, runProfile)).toBe("gap");
  });
});

describe("pause ledger", () => {
  it("pauses the intervals ending in (pause, resume] and keeps an open pause to the end", () => {
    const ledger = new PauseLedger();
    for (const mark of [{ kind: "start", t: 0 }, { kind: "pause", t: 100 }, { kind: "resume", t: 200 }, { kind: "stop", t: 500 }] as const) ledger.mark(mark);
    expect([50, 100, 101, 200, 201, 500, 501].map((t) => ledger.isPaused(t))).toEqual([false, false, true, true, false, false, true]);
    expect(ledger.spans({ startMs: 150, endMs: 600 })).toEqual([
      { startMs: 150, endMs: 200 },
      { startMs: 500, endMs: 600 },
    ]);
  });
});

describe("automatic laps (REC-041)", () => {
  it("counts the distance from the last lap of any kind", () => {
    const lapper = new AutoLapper({ trigger: "distance", meters: 1000 });
    expect(lapper.advance({ t: 0, distance: 0, moving: 0 }, { t: 1000, distance: 2500, moving: 1000 })).toEqual([0.4, 0.8]);
    lapper.restart({ t: 1000, distance: 2500, moving: 1000 });
    expect(lapper.advance({ t: 1000, distance: 2500, moving: 1000 }, { t: 2000, distance: 3400, moving: 2000 })).toEqual([]);
    expect(lapper.advance({ t: 2000, distance: 3400, moving: 2000 }, { t: 3000, distance: 3600, moving: 3000 })).toEqual([0.5]);
  });

  it("counts the moving time for duration laps", () => {
    const lapper = new AutoLapper({ trigger: "duration", ms: 60_000 });
    expect(lapper.advance({ t: 0, distance: 0, moving: 0 }, { t: 100_000, distance: 0, moving: 30_000 })).toEqual([]);
    expect(lapper.advance({ t: 100_000, distance: 0, moving: 30_000 }, { t: 160_000, distance: 0, moving: 90_000 })).toEqual([0.5]);
    expect(new AutoLapper(null).advance({ t: 0, distance: 0, moving: 0 }, { t: 1, distance: 1e6, moving: 1e6 })).toEqual([]);
  });
});

describe("cumulative columns", () => {
  it("interpolates fractional indices by value and by time", () => {
    const column = Float64Array.of(0, 0, 10, 10, 30);
    expect(locate(column, 5)).toBe(1.5);
    expect(locate(column, 10)).toBe(2);
    expect(locate(column, 20, 2)).toBe(3.5);
    expect(locate(column, 99)).toBe(4);
    expect(locateTime(Float64Array.of(0, 1000, 3000), 2000)).toBe(1.5);
    expect(locateTime(Float64Array.of(0, 1000, 3000), -5)).toBe(0);
    expect(valueAt(column, 3.25)).toBe(15);
  });

  it("merges intervals into runs and counted spans", () => {
    const series = seriesOf([
      { durationMs: 1000, meters: 3, kind: "moving" },
      { durationMs: 1000, meters: 3, kind: "moving" },
      { durationMs: 30_000, meters: 200, kind: "bridged" },
      { durationMs: 5000, meters: 0, kind: "stopped" },
      { durationMs: 1000, meters: 3, kind: "moving" },
    ]);
    expect(motionIntervals(series).map((interval) => interval.kind)).toEqual(["moving", "bridged", "stopped", "moving"]);
    expect(countedSpans(motionIntervals(series))).toEqual([
      { startMs: 0, endMs: 32_000 },
      { startMs: 37_000, endMs: 38_000 },
    ]);
  });
});

describe("best efforts (PR-001, DEC-05)", () => {
  it("equal the exhaustive O(n^2) search on random tracks with stops, gaps and long pauses", () => {
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const series = seriesOf(randomSteps(seed, 500));
      const pauses = pausesOf(series);
      const sections = effortSections(series, pauses);
      for (const meters of [100, 400, 1000]) {
        const expected = exhaustiveDistanceEffort(series, pauses, meters);
        const effort = bestDistanceEffort(series, sections, meters, 0);
        expect(effort === null, `seed ${seed} ${meters} m`).toBe(expected === null);
        if (expected === null || effort === null) continue;
        expect(effort.elapsedMs, `seed ${seed} ${meters} m`).toBe(Math.round(expected.elapsed));
        expect(effort.startOffsetMs, `seed ${seed} ${meters} m`).toBe(Math.round(expected.start));
      }
    }
  });

  it("never span an unfilled gap or a manual pause longer than 5 min", () => {
    const run = (count: number): Step[] => Array.from({ length: count }, () => ({ durationMs: 1000, meters: 4, kind: "moving" as const }));
    const across = (middle: Step): TrackSeries => seriesOf([...run(150), middle, ...run(150)]);
    const best = (series: TrackSeries): number | null => bestDistanceEffort(series, effortSections(series, pausesOf(series)), 1000, 0)?.elapsedMs ?? null;
    expect(best(across({ durationMs: 400_000, meters: 0, kind: "gap" }))).toBeNull();
    expect(best(across({ durationMs: 301_000, meters: 0, kind: "paused" }))).toBeNull();
    expect(best(across({ durationMs: 120_000, meters: 0, kind: "paused" }))).toBe(250_000 + 120_000);
    expect(best(seriesOf(run(300)))).toBe(250_000);
  });

  it("finds the best ascent of an elapsed hour, start interpolated", () => {
    const steps: Step[] = [
      ...Array.from({ length: 1800 }, () => ({ durationMs: 1000, meters: 1, kind: "moving" as const, climb: 0.1 })),
      ...Array.from({ length: 3600 }, () => ({ durationMs: 1000, meters: 1, kind: "moving" as const, climb: 0.2 })),
      ...Array.from({ length: 1800 }, () => ({ durationMs: 1000, meters: 1, kind: "moving" as const, climb: 0 })),
    ];
    const series = seriesOf(steps);
    const effort = bestAscentEffort(series, effortSections(series, []), 3_600_000, 0);
    expect(effort?.ascentMm).toBe(720_000);
    expect(effort?.startOffsetMs).toBe(1_800_000);
    expect(bestAscentEffort(seriesOf(steps.slice(0, 3000)), new Uint32Array(3001), 3_600_000, 0)).toBeNull();
  });
});

describe("splits and laps (GPS-060, GPS-061, REC-042)", () => {
  const steady = seriesOf(Array.from({ length: 1050 }, () => ({ durationMs: 1000, meters: 3, kind: "moving" as const, climb: 0.01 })));
  const window: TimeSpan = { startMs: 0, endMs: 1_050_000 };

  it("cut the counted distance at interpolated bounds, the last split keeping its real length", () => {
    const splits = splitsOf(steady, null, true, 1000, window);
    expect(splits.map((split) => split.distanceMm)).toEqual([1_000_000, 1_000_000, 1_000_000, 150_000]);
    expect(splits[0]?.endMs).toBeCloseTo(333_333.33, 1);
    expect(splits[0]?.ascentMm).toBe(3333);
    expect(splits.at(-1)?.endMs).toBe(window.endMs);
    expect(splitsOf(steady, null, true, null, window)).toEqual([]);
  });

  it("end laps at the lap marks and restart the automatic count after each of them", () => {
    const bounds = recordedLapBounds(steady, [{ kind: "lap", t: 100_000 }], { trigger: "distance", meters: 1000 }, window);
    expect(bounds.map((lap) => lap.trigger)).toEqual(["manual", "distance", "distance", "distance"]);
    expect(bounds.map((lap) => lap.endOffsetMs)).toEqual([100_000, 433_333, 766_667, 1_050_000]);
    const laps = summarizeLaps(steady, null, true, bounds, window);
    [300_000, 1_000_000, 1_000_000, 850_000].forEach((distanceMm, index) => expect(Math.abs((laps[index]?.distanceMm ?? 0) - distanceMm)).toBeLessThanOrEqual(3));
    expect(recordedLapBounds(steady, [], null, window)).toEqual([{ trigger: "manual", startOffsetMs: 0, endOffsetMs: 1_050_000, workoutStep: null }]);
  });

  it("clip given laps to the activity and drop the empty ones", () => {
    const laps = summarizeLaps(steady, null, false, [
      { trigger: "import", startOffsetMs: 0, endOffsetMs: 600_000, workoutStep: null },
      { trigger: "import", startOffsetMs: 600_000, endOffsetMs: 2_000_000, workoutStep: null },
      { trigger: "import", startOffsetMs: 2_000_000, endOffsetMs: 3_000_000, workoutStep: null },
    ], window);
    expect(laps.map((lap) => lap.bounds.endOffsetMs)).toEqual([600_000, 1_050_000]);
    expect(laps[0]?.ascentMm).toBeNull();
  });
});

describe("heart rate over counted intervals (SPT-003)", () => {
  it("weights the readings by the moving time they hold, without filling dropouts", () => {
    const series = seriesOf([
      { durationMs: 10_000, meters: 30, kind: "moving" },
      { durationMs: 10_000, meters: 0, kind: "stopped" },
      { durationMs: 10_000, meters: 30, kind: "moving" },
    ]);
    const heartRate = heartRateColumns([[0, 120], [4000, 140], [12_000, 100], [21_000, 160], [24_000, 0], [29_000, 150]]);
    const { beats, coveredMs } = accumulateHeartRate(series, heartRate);
    const overlap = new SpanOverlap(countedSpans(motionIntervals(series)));
    let expectedBeats = 0;
    let expectedMs = 0;
    forEachHeartRateSpan(heartRate, { startMs: 0, endMs: 30_000 }, (startMs, endMs, bpm) => {
      const duration = overlap.of(startMs, endMs);
      expectedBeats += (bpm * duration) / 60_000;
      expectedMs += duration;
    });
    expect(coveredMs.at(-1)).toBe(expectedMs);
    expect(coveredMs.at(-1)).toBe(4000 + 5000 + 3000 + 1000);
    expect(beats.at(-1)).toBeCloseTo(expectedBeats, 9);
  });
});

describe("speeds (GPS-035)", () => {
  it("smooths the speed exponentially and takes the 3 s maximum on counted intervals only", () => {
    const smoother = new SpeedSmoother(6000);
    expect(smoother.push(0, 3)).toBe(3);
    expect(smoother.push(6000, 4)).toBeCloseTo(3 + (1 - Math.exp(-1)), 9);
    const series = seriesOf([
      { durationMs: 1000, meters: 3, kind: "moving" },
      { durationMs: 1000, meters: 3, kind: "moving" },
      { durationMs: 1000, meters: 9, kind: "moving" },
      { durationMs: 1000, meters: 3, kind: "moving" },
      { durationMs: 1000, meters: 3, kind: "moving" },
      { durationMs: 1000, meters: 30, kind: "gap" },
    ]);
    expect(maxWindowSpeed(series)).toBe(5);
  });
});
