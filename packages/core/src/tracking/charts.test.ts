import { beforeAll, describe, expect, it } from "vitest";
import type { EpochMs } from "@obnixe/schema";
import { processTrack } from "./batch.ts";
import type { ProcessedTrack } from "./batch.ts";
import { axisAtIndex, axisColumn, axisLength, chartSeries, downsample, indexAtAxis, metricColumn, quantile, robustRange } from "./charts.ts";
import { coreScenarios } from "./testing/scenarios.ts";
import { profileOf, recordedLaps, untrimmed } from "./testing/run.ts";
import { toSampleColumns } from "./types.ts";
import type { HeartRateColumns } from "./types.ts";

let processed: ProcessedTrack;
const noHeartRate: HeartRateColumns = { length: 0, t: new Uint32Array(0), bpm: new Uint16Array(0), rrInterval: new Int32Array(0) };
const profile = { pacePerMeters: 1000 as const };

beforeAll(() => {
  const scenario = coreScenarios.steadyRun(4);
  const endT = scenario.samples.at(-1)?.t ?? 0;
  const track = { startedAt: Date.UTC(2026, 9, 24, 7, 30) as EpochMs, samples: toSampleColumns(scenario.samples), marks: [{ kind: "start" as const, t: 0 }, { kind: "stop" as const, t: endT }] };
  processed = processTrack(track, profileOf(scenario), { laps: recordedLaps, trim: untrimmed });
});

describe("downsampling (SUM-002)", () => {
  it("keeps at most the budget, both ends and the extremes", () => {
    const x = Float64Array.from({ length: 10_000 }, (_, index) => index);
    const y = x.map((value) => Math.sin(value / 300) * 100);
    y[4321] = 500;
    const line = downsample(x, y, 400);
    expect(line.x.length).toBeLessThanOrEqual(400);
    expect(line.x[0]).toBe(0);
    expect(line.x.at(-1)).toBe(9999);
    expect(Math.max(...line.y)).toBe(500);
  });

  it("breaks the line between runs of known values", () => {
    const x = Float64Array.from({ length: 10 }, (_, index) => index);
    const y = Float64Array.from([1, 2, 3, Number.NaN, Number.NaN, 4, 5, 6, 7, 8]);
    const line = downsample(x, y, 100);
    expect(Array.from(line.y).map((value) => (Number.isNaN(value) ? null : value))).toEqual([1, 2, 3, null, 4, 5, 6, 7, 8]);
    expect(line.x[3]).toBe(5);
  });

  it("reduces a 6 h track at 1 Hz to two points per pixel", () => {
    const length = 6 * 3600;
    const x = Float64Array.from({ length }, (_, index) => index * 3.2);
    const y = Float64Array.from({ length }, (_, index) => 1200 + Math.sin(index / 500) * 300 + (index % 7));
    const startedAt = performance.now();
    const line = downsample(x, y, 2 * 360);
    expect(performance.now() - startedAt).toBeLessThan(200);
    expect(line.x.length).toBeLessThanOrEqual(720);
  });
});

describe("robust bounds (MAP-021)", () => {
  it("interpolates quantiles over the finite values", () => {
    expect(quantile([4, 1, Number.NaN, 3, 2], 0.5)).toBe(2.5);
    expect(quantile([Number.NaN], 0.5)).toBeNull();
  });

  it("ignores an isolated spike", () => {
    const values = Float64Array.from({ length: 200 }, (_, index) => 10 + (index % 10));
    values[50] = 1000;
    expect(robustRange(values)?.max).toBeLessThan(20);
  });
});

describe("activity charts", () => {
  it("maps the axis to the series and back by binary search (MAP-022)", () => {
    const distance = axisColumn(processed, "distance");
    const total = axisLength(processed, "distance");
    expect(total).toBeGreaterThan(3500);
    const index = indexAtAxis(distance, total / 2);
    expect(axisAtIndex(distance, index)).toBeCloseTo(total / 2, 3);
    const time = axisColumn(processed, "time");
    expect(time[0]).toBe(0);
    expect(axisLength(processed, "time")).toBe(processed.elapsed.endMs - processed.elapsed.startMs);
  });

  it("charts the pace of a steady run around its average and leaves the heart rate out without a stream", () => {
    const pace = chartSeries(axisColumn(processed, "distance"), metricColumn(processed, profile, noHeartRate, "pace"), "pace", 600);
    const average = (processed.summary.movingMs / processed.summary.distanceMm) * 1000;
    expect(pace).not.toBeNull();
    expect(pace?.range.min).toBeLessThan(average);
    expect(pace?.range.max).toBeGreaterThan(average);
    expect(chartSeries(axisColumn(processed, "distance"), metricColumn(processed, profile, noHeartRate, "heart_rate"), "heart_rate", 600)).toBeNull();
  });
});
