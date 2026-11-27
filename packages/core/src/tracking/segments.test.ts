import { describe, expect, it } from "vitest";
import type { EpochMs, Id, Segment, SportKey } from "@obnixe/schema";
import type { Environment } from "../database.ts";
import type { ProcessedTrack } from "./batch.ts";
import { decodePolyline } from "./codec/polyline.ts";
import { InvalidSegmentError, candidateShapes, newSegment, renameSegment, segmentFamilyOf, segmentPasses, segmentProblem, segmentShape } from "./segments.ts";
import type { SegmentPlan, SegmentShape } from "./segments.ts";
import { locate, valueAt } from "./stages/derive.ts";
import { buildTruth, clearSky, move, simulate } from "./testing/scenarios.ts";
import type { Leg, Scenario } from "./testing/scenarios.ts";
import { runBatch } from "./testing/run.ts";

const origin = { latitude: 45.1885, longitude: 5.7245, altitude: 214 };
const pace = 1000 / 300;

function outing(legs: readonly Leg[], seed: number, sport: SportKey = "run"): Scenario {
  const truth = buildTruth({ ...origin, legs });
  return { sport, truth, ...simulate(truth, clearSky, seed) };
}

let ids = 0;
const env: Environment = { now: () => 1_780_000_000_000 as EpochMs, newId: () => `segment-${++ids}` as Id };

function rowOf(plan: SegmentPlan): Segment {
  if (plan.mutation.kind !== "insert" || plan.mutation.table !== "segment") throw new Error("Not a segment insert");
  const { row } = plan.mutation;
  return { ...row, sourceSessionId: row.sourceSessionId ?? null, deletedAt: null, createdAt: env.now(), updatedAt: env.now() };
}

/** The segment drawn over `[fromMeters, toMeters]` of the activity's distance. */
function drawn(processed: ProcessedTrack, fromMeters: number, toMeters: number, sport: SportKey = "run"): Segment {
  const { distance } = processed.series;
  const range = { from: locate(distance, fromMeters), to: locate(distance, toMeters) };
  return rowOf(newSegment(env, processed.series, processed.summary.ascentMm !== null, { name: " Montée ", sport, sessionId: "session" as Id, range }));
}

const shapeOf = (row: Segment): SegmentShape => segmentShape(row);

/** East 1 km, north 600 m, west 1 km. */
const hook = [move(1000, pace, 90), move(600, pace, 0), move(1000, pace, 270)];
const reversedHook = [move(1000, pace, 90), move(600, pace, 180), move(1000, pace, 270)];

describe("segment creation (SEG-001)", () => {
  const processed = runBatch(outing(hook, 1));

  it("stores the stretch simplified at 2 m with its distance, family and box", () => {
    const row = drawn(processed, 1100, 1500);
    expect(row).toMatchObject({ name: "Montée", family: "foot", sourceSessionId: "session", deletedAt: null });
    expect(row.distanceMm).toBeGreaterThan(399_000);
    expect(row.distanceMm).toBeLessThan(401_000);
    const path = decodePolyline(row.polyline, 6);
    expect(path.length).toBeGreaterThanOrEqual(2);
    expect(path.length).toBeLessThan(60);
    expect(row.south).toBe(row.bbox.south);
    expect(row.north).toBe(row.bbox.north);
    for (let index = 0; index < path.length; index += 1) {
      expect(path.latitudeE7[index]).toBeGreaterThanOrEqual(row.bbox.south);
      expect(path.latitudeE7[index]).toBeLessThanOrEqual(row.bbox.north);
    }
  });

  it("refuses a blank name, a sport without segments and a stretch under 100 m", () => {
    const range = { from: locate(processed.series.distance, 1100), to: locate(processed.series.distance, 1180) };
    expect(segmentProblem(processed.series, { name: " ", sport: "run", sessionId: "session" as Id, range })).toBe("name");
    expect(segmentProblem(processed.series, { name: "Pont", sport: "inline_skate", sessionId: "session" as Id, range })).toBe("sport");
    expect(segmentProblem(processed.series, { name: "Pont", sport: "run", sessionId: "session" as Id, range })).toBe("length");
    expect(() => newSegment(env, processed.series, false, { name: "Pont", sport: "run", sessionId: "session" as Id, range })).toThrow(InvalidSegmentError);
  });

  it("maps every sport to its family", () => {
    expect(segmentFamilyOf("trail")).toBe("foot");
    expect(segmentFamilyOf("hike")).toBe("foot");
    expect(segmentFamilyOf("bike")).toBe("bike");
    expect(segmentFamilyOf("climb")).toBeNull();
    expect(segmentFamilyOf("ski_touring")).toBe("snow");
    expect(segmentFamilyOf("nordic_ski")).toBe("snow");
    expect(segmentFamilyOf("alpine_ski")).toBe("snow");
    expect(segmentFamilyOf("paddle")).toBe("water");
    expect(segmentFamilyOf("swim")).toBe("water");
    expect(segmentFamilyOf("inline_skate")).toBeNull();
  });

  it("renames without touching the geometry", () => {
    const row = drawn(processed, 1100, 1500);
    expect(renameSegment(row, "Montée")).toBeNull();
    expect(renameSegment(row, " Côte ")).toEqual({ kind: "update", table: "segment", key: row.id, patch: { name: "Côte" } });
    expect(() => renameSegment(row, "")).toThrow(InvalidSegmentError);
  });
});

describe("segment detection (SEG-002)", () => {
  const source = runBatch(outing(hook, 1));
  const segment = drawn(source, 1100, 1500);
  const shape = shapeOf(segment);

  it("finds the activity the segment was drawn from, timed at the chosen ends", () => {
    const passes = segmentPasses(source, [shape]);
    expect(passes).toHaveLength(1);
    const pass = passes[0];
    const from = locate(source.series.distance, 1100);
    const to = locate(source.series.distance, 1500);
    expect(Math.abs((pass?.startOffsetMs ?? 0) - (valueAt(source.series.t, from) - source.elapsed.startMs))).toBeLessThan(2000);
    expect(Math.abs((pass?.elapsedMs ?? 0) - (valueAt(source.series.t, to) - valueAt(source.series.t, from)))).toBeLessThan(2000);
    expect(pass).toMatchObject({ segmentId: segment.id, occurrence: 0, algorithmVersion: source.algorithmVersion });
  });

  it("finds another activity on the same road, with its own noise", () => {
    const passes = segmentPasses(runBatch(outing(hook, 7)), [shape]);
    expect(passes).toHaveLength(1);
    expect(Math.abs((passes[0]?.elapsedMs ?? 0) - 400 * 300)).toBeLessThan(6000);
    expect(passes[0]?.movingMs).toBeLessThanOrEqual(passes[0]?.elapsedMs ?? 0);
  });

  it("finds no pass when the segment is run the other way", () => {
    expect(segmentPasses(runBatch(outing(reversedHook, 2)), [shape])).toHaveLength(0);
  });

  it("finds three passes over a loop run three times", () => {
    const lap = [move(300, pace, 90), move(300, pace, 0), move(300, pace, 270), move(300, pace, 180)];
    const loops = runBatch(outing([...lap, ...lap, ...lap], 3));
    const loopShape = shapeOf(drawn(loops, 320, 880));
    const passes = segmentPasses(runBatch(outing([...lap, ...lap, ...lap], 4)), [loopShape]);
    expect(passes.map((pass) => pass.occurrence)).toEqual([0, 1, 2]);
    for (const pass of passes) expect(Math.abs(pass.elapsedMs - 560 * 300)).toBeLessThan(10_000);
    expect((passes[1]?.startOffsetMs ?? 0) - (passes[0]?.startOffsetMs ?? 0)).toBeGreaterThan(1100 * 300);
  });

  it("finds no pass over a detour whose length leaves the 10 % tolerance", () => {
    const zigzag: Leg[] = [move(1000, pace, 90)];
    for (let step = 0; step < 20; step += 1) zigzag.push(move(30, pace, step % 2 === 0 ? 30 : 330));
    zigzag.push(move(1000, pace, 270));
    expect(segmentPasses(runBatch(outing(zigzag, 5)), [shape])).toHaveLength(0);
  });

  it("finds no pass when the track leaves the segment between its ends", () => {
    const longStraight = runBatch(outing([move(1200, pace, 0)], 6));
    const straight = shapeOf(drawn(longStraight, 100, 700));
    const bend = Math.atan2(120, 300) * (180 / Math.PI);
    const veer = [move(100, pace, 0), move(Math.hypot(300, 120), pace, bend), move(Math.hypot(300, 120), pace, 360 - bend), move(500, pace, 0)];
    expect(segmentPasses(runBatch(outing(veer, 8)), [straight])).toHaveLength(0);
    expect(segmentPasses(runBatch(outing([move(1200, pace, 0)], 9)), [straight])).toHaveLength(1);
  });

  it("keeps to the segments of the activity's family and box", () => {
    const bikeShape = { ...shape, family: "bike" as const };
    const far = { ...shape, bbox: { south: 0, west: 0, north: 10_000_000, east: 10_000_000 } };
    expect(candidateShapes([shape, bikeShape, far], "trail", source.summary.bbox)).toEqual([shape]);
    expect(candidateShapes([shape], "swim", source.summary.bbox)).toEqual([]);
  });
});
