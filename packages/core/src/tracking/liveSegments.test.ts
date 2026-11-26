import { describe, expect, it } from "vitest";
import type { EpochMs, Id, Segment } from "@obnixe/schema";
import type { Environment } from "../database.ts";
import type { ProcessedTrack } from "./batch.ts";
import { LiveSegmentWatch } from "./liveSegments.ts";
import type { LiveSegmentEvent, LiveSegmentTarget } from "./liveSegments.ts";
import { newSegment, segmentPasses, segmentShape } from "./segments.ts";
import { locate } from "./stages/derive.ts";
import { runBatch, runLive } from "./testing/run.ts";
import { buildTruth, clearSky, mountainOuting, move, simulate, stop } from "./testing/scenarios.ts";
import type { Leg, Scenario } from "./testing/scenarios.ts";

const pace = 1000 / 300;
const env: Environment = { now: () => 1_780_000_000_000 as EpochMs, newId: () => "segment" as Id };

function outing(legs: readonly Leg[], seed: number): Scenario {
  const truth = buildTruth({ latitude: 45.1885, longitude: 5.7245, altitude: 214, legs });
  return { sport: "run", truth, ...simulate(truth, clearSky, seed) };
}

function drawn(processed: ProcessedTrack, fromMeters: number, toMeters: number): Segment {
  const { distance } = processed.series;
  const plan = newSegment(env, processed.series, false, { name: "Côte du pont", sport: "run", sessionId: "session" as Id, range: { from: locate(distance, fromMeters), to: locate(distance, toMeters) } });
  if (plan.mutation.kind !== "insert" || plan.mutation.table !== "segment") throw new Error("Not a segment insert");
  return { ...plan.mutation.row, sourceSessionId: "session" as Id, deletedAt: null, createdAt: env.now(), updatedAt: env.now() };
}

function watched(scenario: Scenario, targets: readonly LiveSegmentTarget[]): readonly LiveSegmentEvent[] {
  const watch = new LiveSegmentWatch(targets);
  return runLive(scenario).track.flatMap((point) => watch.push(point));
}

const hook = [move(1000, pace, 90), move(600, pace, 0), move(1000, pace, 270)];
const reversedHook = [move(1000, pace, 90), move(600, pace, 180), move(1000, pace, 270)];

describe("live segment passes (SEG-004)", () => {
  const segment = drawn(runBatch(outing(hook, 1)), 1100, 1500);
  const target: LiveSegmentTarget = { shape: segmentShape(segment), name: segment.name, bestElapsedMs: 125_000 };

  it("announces the entry, then the time of the pass against the best, close to the pass stored afterwards", () => {
    for (const seed of [7, 8, 9]) {
      const scenario = outing(hook, seed);
      const events = watched(scenario, [target]);
      expect(events.map((event) => event.kind), `seed ${seed}`).toEqual(["segment_entered", "segment_finished"]);
      expect(events[0]).toEqual({ kind: "segment_entered", segmentId: segment.id, name: "Côte du pont", bestElapsedMs: 125_000 });
      const finished = events[1];
      const stored = segmentPasses(runBatch(scenario), [target.shape])[0];
      expect(finished?.kind === "segment_finished" ? finished.bestElapsedMs : null).toBe(125_000);
      expect(Math.abs((finished?.kind === "segment_finished" ? finished.elapsedMs : 0) - (stored?.elapsedMs ?? 0)), `seed ${seed}`).toBeLessThan(3000);
    }
  });

  it("stays silent on the segment run the other way and on a segment of another place", () => {
    expect(watched(outing(reversedHook, 2), [target])).toEqual([]);
    const elsewhere = drawn(runBatch(outing([move(1200, pace, 0)], 3)), 100, 700);
    expect(watched(outing(hook, 4), [{ shape: segmentShape(elsewhere), name: elsewhere.name, bestElapsedMs: null }])).toEqual([]);
  });

  it("enters but never finishes when the track leaves the segment between its ends", () => {
    const straight = drawn(runBatch(outing([move(1200, pace, 0)], 6)), 100, 700);
    const bend = Math.atan2(120, 300) * (180 / Math.PI);
    const veer = [move(100, pace, 0), move(Math.hypot(300, 120), pace, bend), move(Math.hypot(300, 120), pace, 360 - bend), move(500, pace, 0)];
    expect(watched(outing(veer, 8), [{ shape: segmentShape(straight), name: straight.name, bestElapsedMs: null }]).map((event) => event.kind)).toEqual(["segment_entered"]);
  });

  it("times each lap of a loop against the best so far, this activity's laps included", () => {
    const lap = [move(300, pace, 90), move(300, pace, 0), move(300, pace, 270), move(300, pace, 180)];
    const loop = drawn(runBatch(outing([...lap, ...lap, ...lap], 3)), 320, 880);
    const events = watched(outing([...lap, ...lap, ...lap], 4), [{ shape: segmentShape(loop), name: loop.name, bestElapsedMs: null }]);
    const finished = events.flatMap((event) => (event.kind === "segment_finished" ? [event] : []));
    expect(events.filter((event) => event.kind === "segment_entered")).toHaveLength(3);
    expect(finished).toHaveLength(3);
    expect(finished[0]?.bestElapsedMs).toBeNull();
    for (const [index, event] of finished.entries()) {
      expect(Math.abs(event.elapsedMs - 560 * 300)).toBeLessThan(10_000);
      if (index > 0) expect(event.bestElapsedMs).toBe(Math.min(...finished.slice(0, index).map((earlier) => earlier.elapsedMs)));
    }
  });

  it("counts a stop on the segment in the elapsed time, like the stored pass", () => {
    const paused = [move(1000, pace, 90), move(300, pace, 0), stop(60_000), move(300, pace, 0), move(1000, pace, 270)];
    const scenario = outing(paused, 5);
    const finished = watched(scenario, [target]).find((event) => event.kind === "segment_finished");
    const stored = segmentPasses(runBatch(scenario), [target.shape])[0];
    expect(stored).toBeDefined();
    expect(Math.abs((finished?.kind === "segment_finished" ? finished.elapsedMs : 0) - (stored?.elapsedMs ?? 0))).toBeLessThan(3000);
  });

  it("follows 200 segments over a 3 h outing within 0.2 ms per point on average", () => {
    const scenario = mountainOuting(3, 1);
    const processed = runBatch(scenario);
    const total = processed.series.distance.at(-1) ?? 0;
    const targets = Array.from({ length: 200 }, (_, index): LiveSegmentTarget => {
      const from = ((index * 137) % 190) * (total / 200);
      const row = drawn(processed, from, from + 300 + (index % 7) * 400);
      return { shape: segmentShape(row), name: row.name, bestElapsedMs: null };
    });
    const track = runLive(scenario).track;
    const watch = new LiveSegmentWatch(targets);
    const started = performance.now();
    const finished = track.flatMap((point) => watch.push(point)).filter((event) => event.kind === "segment_finished");
    const perPoint = (performance.now() - started) / track.length;
    expect(finished.length).toBeGreaterThanOrEqual(200);
    expect(perPoint).toBeLessThan(0.2);
  }, 60_000);
});
