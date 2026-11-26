import { beforeAll, describe, expect, it } from "vitest";
import type { ProcessedTrack } from "@obnixe/core";
import { colorScale, cursorPoint, emptyCollection, kilometerStep, mapMaxPoints, metricValue, progressValue, TrackIndex, trackGeometry, trackLines, trackMarks, unknownValue } from "@/features/recordings/trackMap";
import { processedRun } from "../../../test/tracks.ts";

interface Feature {
  readonly properties: { readonly kind: string; readonly v?: number; readonly label?: string };
  readonly geometry: { readonly type: string; readonly coordinates: readonly unknown[] };
}

const featuresOf = (data: string): readonly Feature[] => (JSON.parse(data) as { features: Feature[] }).features;

let run: ProcessedTrack;
let long: ProcessedTrack;

beforeAll(() => {
  run = processedRun(40 * 60);
  long = processedRun(6 * 3600);
});

describe("detail map geometry (MAP-020)", () => {
  it("frames the whole track and keeps both ends", () => {
    const geometry = trackGeometry(run, null);
    expect(geometry.kept[0]).toBe(0);
    expect(geometry.kept.at(-1)).toBe(run.series.length - 1);
    const [west, south, east, north] = geometry.bounds ?? [0, 0, 0, 0];
    expect(west).toBeLessThan(east);
    expect(south).toBeLessThan(north);
    expect(geometry.hidden).toBeNull();
  });

  it("hides the ends asked by the in-app mask", () => {
    const geometry = trackGeometry(run, { zones: [], hideEndsMeters: 500 });
    const first = geometry.kept[0] ?? 0;
    expect(run.series.distance[first]).toBeGreaterThanOrEqual(500);
    expect(geometry.hidden?.[0]).toBe(1);
    expect(cursorPoint(run, geometry, 0)).toBe(emptyCollection);
  });

  it("puts a stone every km, every 5 km beyond 30 km, with start and finish", () => {
    expect(kilometerStep(30_000)).toBe(1000);
    expect(kilometerStep(30_001)).toBe(5000);
    const marks = featuresOf(trackMarks(run, run.laps, trackGeometry(run, null)));
    const stones = marks.filter((mark) => mark.properties.kind === "km").map((mark) => mark.properties.label);
    expect(stones).toEqual(["1", "2", "3", "4", "5", "6", "7"]);
    expect(marks.filter((mark) => mark.properties.kind === "start")).toHaveLength(1);
    expect(marks.filter((mark) => mark.properties.kind === "finish")).toHaveLength(1);
    const longStones = featuresOf(trackMarks(long, long.laps, trackGeometry(long, null))).filter((mark) => mark.properties.kind === "km");
    expect(longStones.map((mark) => mark.properties.label).slice(0, 3)).toEqual(["5", "10", "15"]);
  });
});

describe("colored track (MAP-021)", () => {
  it("bounds a metric on its 5th and 95th percentiles, the grade symmetrically", () => {
    const values = Float64Array.from({ length: 101 }, (_, index) => (index === 100 ? 10_000 : index));
    expect(colorScale("altitude", values)?.range).toEqual({ min: 5, max: 95 });
    const grades = Float64Array.from({ length: 101 }, (_, index) => (index - 20) / 1000);
    const grade = colorScale("grade", grades);
    expect(grade?.range.min).toBe(-(grade?.range.max ?? 0));
    expect(grade?.range.max).toBe(0.075);
    expect(colorScale("speed", new Float64Array(10).fill(3))).toBeNull();
  });

  it("chunks the line by quantized value and marks unknown values", () => {
    const geometry = trackGeometry(run, null);
    const progress = featuresOf(trackLines(run, geometry, progressValue(run))).filter((item) => item.properties.kind === "track");
    const levels = progress.map((item) => item.properties.v ?? 0);
    expect(levels[0]).toBeLessThan(0.1);
    expect(levels.at(-1)).toBe(1);
    expect(levels.every((level, index) => index === 0 || level >= (levels[index - 1] ?? 0))).toBe(true);
    const unknown = featuresOf(trackLines(run, geometry, () => Number.NaN)).filter((item) => item.properties.kind === "track");
    expect(unknown.every((item) => item.properties.v === unknownValue)).toBe(true);
    expect(unknown.every((item) => item.geometry.coordinates.length <= 120)).toBe(true);
  });

  it("averages a metric over each chunk on its scale", () => {
    const values = Float64Array.from({ length: 10 }, (_, index) => index);
    const value = metricValue(values, { kind: "ramp", range: { min: 0, max: 10 } }, []);
    expect(value(0, 2)).toBeCloseTo(0.15);
    const zones = metricValue(Float64Array.from([120, 150, 175]), { kind: "zones", range: { min: 0, max: 5 } }, [
      { zone: 1, minBpm: 100, maxBpm: 130 },
      { zone: 2, minBpm: 130, maxBpm: 160 },
      { zone: 3, minBpm: 160, maxBpm: 190 },
    ]);
    expect(zones(0, 1)).toBe(2);
    expect(zones(1, 2)).toBe(3);
  });

  it("stays light and fast on a 6 h track", () => {
    const startedAt = performance.now();
    const geometry = trackGeometry(long, null);
    const scale = colorScale("altitude", long.series.altitude);
    if (scale === null) throw new Error("flat track");
    const lines = trackLines(long, geometry, metricValue(long.series.altitude, scale, []));
    expect(performance.now() - startedAt).toBeLessThan(1500);
    expect(geometry.kept.length).toBeLessThanOrEqual(mapMaxPoints + 2);
    expect(featuresOf(lines).length).toBeLessThan(600);
  });
});

describe("map cursor (MAP-022)", () => {
  it("finds the drawn point nearest to a touch, nothing far from the track", () => {
    const geometry = trackGeometry(run, null);
    const grid = new TrackIndex(run, geometry.kept);
    const target = geometry.kept[Math.floor(geometry.kept.length / 2)] ?? 0;
    const latitude = run.series.latitude[target] ?? 0;
    const longitude = run.series.longitude[target] ?? 0;
    expect(grid.nearest(latitude + 5 / 111_320, longitude, 30)).toBe(target);
    expect(grid.nearest(latitude + 0.05, longitude, 30)).toBeNull();
    const cursor = featuresOf(cursorPoint(run, geometry, target));
    expect(cursor[0]?.geometry.coordinates).toEqual([Number(longitude.toFixed(6)), Number(latitude.toFixed(6))]);
  });
});
