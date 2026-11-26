import type { ProcessedTrack } from "./batch.ts";
import type { ResolvedProfile } from "./profile.ts";
import { lttb } from "./simplify.ts";
import { intervalCodes, isCountedCode, locateTime, slowestPaceSecondsPerKm, valueAt } from "./stages/derive.ts";
import { powerReadings, sensorReader } from "./sensors.ts";
import type { SampleColumns } from "./types.ts";
import { heartRateReader } from "./zones.ts";

/** `SUM-002`: distance by default, elapsed time on demand. */
export type ChartAxis = "distance" | "time";

export type ChartMetric = "altitude" | "pace" | "speed" | "heart_rate" | "power";

/** The kept points of a chart: `x` in meters or ms since the start, `y` in meters, s per pace unit, m/s, bpm or W; `NaN` breaks the line. */
export interface ChartLine {
  readonly x: Float64Array;
  readonly y: Float64Array;
}

export interface ValueRange {
  readonly min: number;
  readonly max: number;
}

/** What a chart draws: its kept points and the range of its scale. */
export interface ChartSeries {
  readonly metric: ChartMetric;
  readonly line: ChartLine;
  readonly range: ValueRange;
}

/** The position of each series entry on the axis: cumulated meters, or ms since the start of the activity. */
export function axisColumn(processed: Pick<ProcessedTrack, "series" | "elapsed">, axis: ChartAxis): Float64Array {
  const { series, elapsed } = processed;
  switch (axis) {
    case "distance":
      return series.distance;
    case "time":
      return series.t.map((t) => t - elapsed.startMs);
    default: {
      const unreachable: never = axis;
      return unreachable;
    }
  }
}

/** The extent of the axis from the start to the end of the activity. */
export function axisLength(processed: Pick<ProcessedTrack, "series" | "elapsed">, axis: ChartAxis): number {
  switch (axis) {
    case "distance":
      return processed.series.distance[processed.series.length - 1] ?? 0;
    case "time":
      return processed.elapsed.endMs - processed.elapsed.startMs;
    default: {
      const unreachable: never = axis;
      return unreachable;
    }
  }
}

/** Fractional series index at an axis position, by binary search on the non-decreasing column (`MAP-022`). */
export function indexAtAxis(column: Float64Array, position: number): number {
  return locateTime(column, position);
}

/** The axis position of a fractional series index. */
export function axisAtIndex(column: Float64Array, index: number): number {
  return valueAt(column, index);
}

const paused = new Set([intervalCodes.paused, intervalCodes.gap]);

/** The metric at each series entry; `NaN` where it is unknown or meaningless, such as a pace while stopped. */
export function metricColumn(processed: Pick<ProcessedTrack, "series">, profile: Pick<ResolvedProfile, "pacePerMeters">, samples: Pick<SampleColumns, "heartRate" | "power">, metric: ChartMetric): Float64Array {
  const { series } = processed;
  const values = new Float64Array(series.length);
  switch (metric) {
    case "altitude":
      values.set(series.altitude);
      return values;
    case "speed":
      for (let index = 0; index < series.length; index += 1) values[index] = paused.has(series.interval[index] ?? 0) ? Number.NaN : (series.speed[index] ?? 0);
      return values;
    case "pace": {
      const slowest = (slowestPaceSecondsPerKm * profile.pacePerMeters) / 1000;
      for (let index = 0; index < series.length; index += 1) {
        const speed = series.speed[index] ?? 0;
        const pace = speed > 0 ? profile.pacePerMeters / speed : Number.POSITIVE_INFINITY;
        values[index] = isCountedCode(series.interval[index] ?? 0) && pace <= slowest ? pace : Number.NaN;
      }
      return values;
    }
    case "heart_rate": {
      const read = heartRateReader(samples.heartRate);
      for (let index = 0; index < series.length; index += 1) values[index] = read(series.t[index] ?? 0) ?? Number.NaN;
      return values;
    }
    case "power": {
      const read = sensorReader(powerReadings(samples.power));
      for (let index = 0; index < series.length; index += 1) values[index] = paused.has(series.interval[index] ?? 0) ? Number.NaN : (read(series.t[index] ?? 0) ?? Number.NaN);
      return values;
    }
    default: {
      const unreachable: never = metric;
      return unreachable;
    }
  }
}

/**
 * At most `maxPoints` points of `y` over `x` (`SUM-002`): Largest Triangle Three Buckets over each run of known values, the
 * budget shared by length, a `NaN` point kept between runs so the line breaks there.
 */
export function downsample(x: ArrayLike<number>, y: ArrayLike<number>, maxPoints: number): ChartLine {
  const runs: { readonly start: number; readonly end: number }[] = [];
  let known = 0;
  for (let index = 0; index < y.length; ) {
    if (!Number.isFinite(y[index] ?? Number.NaN)) {
      index += 1;
      continue;
    }
    const start = index;
    while (index < y.length && Number.isFinite(y[index] ?? Number.NaN)) index += 1;
    runs.push({ start, end: index });
    known += index - start;
  }
  const outX: number[] = [];
  const outY: number[] = [];
  const budget = Math.max(maxPoints - runs.length, runs.length * 2);
  for (const { start, end } of runs) {
    if (outX.length > 0) {
      outX.push(x[start] ?? 0);
      outY.push(Number.NaN);
    }
    const runX = Float64Array.from({ length: end - start }, (_, offset) => x[start + offset] ?? 0);
    const runY = Float64Array.from({ length: end - start }, (_, offset) => y[start + offset] ?? 0);
    const share = known <= maxPoints ? runX.length : Math.max(2, Math.round((budget * runX.length) / known));
    for (const kept of lttb(runX, runY, share)) {
      outX.push(runX[kept] ?? 0);
      outY.push(runY[kept] ?? 0);
    }
  }
  return { x: Float64Array.from(outX), y: Float64Array.from(outY) };
}

/** The `fraction` quantile of the finite values, by linear interpolation; `null` when there is none. */
export function quantile(values: ArrayLike<number>, fraction: number): number | null {
  const kept: number[] = [];
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index] ?? Number.NaN;
    if (Number.isFinite(value)) kept.push(value);
  }
  if (kept.length === 0) return null;
  const finite = Float64Array.from(kept).sort();
  const position = Math.min(Math.max(fraction, 0), 1) * (finite.length - 1);
  const low = Math.floor(position);
  const high = Math.min(low + 1, finite.length - 1);
  return (finite[low] ?? 0) + ((finite[high] ?? 0) - (finite[low] ?? 0)) * (position - low);
}

/** Bounds that an isolated stop or sprint cannot stretch (`MAP-021`): the 5th and 95th percentiles. */
export function robustRange(values: ArrayLike<number>): ValueRange | null {
  const min = quantile(values, 0.05);
  const max = quantile(values, 0.95);
  return min === null || max === null ? null : { min, max };
}

function extent(values: ArrayLike<number>): ValueRange | null {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index] ?? Number.NaN;
    if (!Number.isFinite(value)) continue;
    if (value < min) min = value;
    if (value > max) max = value;
  }
  return min <= max ? { min, max } : null;
}

/** The scale of a chart: the full extent for altitude and heart rate, robust bounds for the noisier pace, speed and power. */
function chartRange(metric: ChartMetric, y: Float64Array): ValueRange | null {
  switch (metric) {
    case "altitude":
    case "heart_rate":
      return extent(y);
    case "pace": {
      const fastest = quantile(y, 0.02);
      const slowest = quantile(y, 0.98);
      return fastest === null || slowest === null ? null : { min: fastest, max: slowest };
    }
    case "speed":
    case "power": {
      const highest = quantile(y, 0.99);
      return highest === null ? null : { min: 0, max: highest };
    }
    default: {
      const unreachable: never = metric;
      return unreachable;
    }
  }
}

/** Minimum share of known values for a chart to be drawn. */
const minKnownShare = 0.1;

/** A chart of `metric` reduced to `maxPoints`, `null` when too little of the activity has a value. */
export function chartSeries(axis: Float64Array, values: Float64Array, metric: ChartMetric, maxPoints: number): ChartSeries | null {
  let known = 0;
  for (const value of values) if (Number.isFinite(value)) known += 1;
  if (known < 2 || known < values.length * minKnownShare) return null;
  const line = downsample(axis, values, maxPoints);
  const range = chartRange(metric, line.y);
  return range === null ? null : { metric, line, range };
}
