import type { ChartAxis, ChartLine, ValueRange } from "@obnixe/core";

/** Maps `[min, max]` linearly onto the pixels `[from, to]`; `to < from` draws upwards. */
export interface PlotScale {
  readonly min: number;
  readonly max: number;
  readonly from: number;
  readonly to: number;
}

export function project(scale: PlotScale, value: number): number {
  const span = scale.max - scale.min;
  return scale.from + ((span === 0 ? 0.5 : (value - scale.min) / span) * (scale.to - scale.from));
}

export function unproject(scale: PlotScale, pixel: number): number {
  const span = scale.to - scale.from;
  return scale.min + (span === 0 ? 0 : (pixel - scale.from) / span) * (scale.max - scale.min);
}

const clamp = (value: number, low: number, high: number): number => Math.min(high, Math.max(low, value));

const pixel = (value: number): string => value.toFixed(1);

/** The SVG path of a chart line, a new subpath after each `NaN`, values clamped to the plot. */
export function linePath(line: ChartLine, x: PlotScale, y: PlotScale): string {
  const top = Math.min(y.from, y.to);
  const bottom = Math.max(y.from, y.to);
  let path = "";
  let open = false;
  for (let index = 0; index < line.x.length; index += 1) {
    const value = line.y[index] ?? Number.NaN;
    if (!Number.isFinite(value)) {
      open = false;
      continue;
    }
    path += `${open ? "L" : "M"}${pixel(project(x, line.x[index] ?? 0))},${pixel(clamp(project(y, value), top, bottom))}`;
    open = true;
  }
  return path;
}

/** The area under a chart line down to `baseline` px, one closed shape per run of known values. */
export function areaPath(line: ChartLine, x: PlotScale, y: PlotScale, baseline: number): string {
  const top = Math.min(y.from, y.to);
  const bottom = Math.max(y.from, y.to);
  let path = "";
  let first: number | null = null;
  let last = 0;
  const close = (): void => {
    if (first !== null) path += `L${pixel(last)},${pixel(baseline)}L${pixel(first)},${pixel(baseline)}Z`;
    first = null;
  };
  for (let index = 0; index < line.x.length; index += 1) {
    const value = line.y[index] ?? Number.NaN;
    if (!Number.isFinite(value)) {
      close();
      continue;
    }
    const px = project(x, line.x[index] ?? 0);
    path += `${first === null ? "M" : "L"}${pixel(px)},${pixel(clamp(project(y, value), top, bottom))}`;
    if (first === null) first = px;
    last = px;
  }
  close();
  return path;
}

/** Round tick values covering `[min, max]` with about `count` intervals, kept inside the range. */
export function valueTicks(range: ValueRange, count: number): readonly number[] {
  const span = range.max - range.min || 1;
  const raw = span / count;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((factor) => factor * magnitude).find((candidate) => candidate >= raw) ?? magnitude * 10;
  const ticks: number[] = [];
  for (let value = Math.ceil(range.min / step) * step; value <= range.max + step * 1e-9; value += step) ticks.push(Math.round(value / step) * step);
  return ticks;
}

const distanceSteps = [100, 200, 500, 1000, 2000, 5000, 10_000, 20_000, 50_000, 100_000];
const timeSteps = [60_000, 120_000, 300_000, 600_000, 900_000, 1_800_000, 3_600_000, 7_200_000, 10_800_000];

/** Positions along the axis, in meters or ms, at least `minSpacing` px apart. */
export function axisTicks(axis: ChartAxis, length: number, width: number, minSpacing: number): readonly number[] {
  const steps = axis === "distance" ? distanceSteps : timeSteps;
  const wanted = (length * minSpacing) / Math.max(1, width);
  const step = steps.find((candidate) => candidate >= wanted) ?? steps[steps.length - 1] ?? 1;
  const ticks: number[] = [];
  for (let value = step; value < length; value += step) ticks.push(value);
  return ticks;
}

/** Padded value range of a chart, never narrower than `minSpan`, so a flat profile does not fill the plot with noise. */
export function paddedRange(range: ValueRange, minSpan: number, padding: number): ValueRange {
  const span = Math.max(range.max - range.min, minSpan);
  const middle = (range.max + range.min) / 2;
  return { min: middle - span / 2 - span * padding, max: middle + span / 2 + span * padding };
}
