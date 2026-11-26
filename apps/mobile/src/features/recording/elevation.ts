import type { ElevationPoint } from "@obnixe/core";

/** A flat outing still draws as a gentle line rather than its altitude noise blown up to the full height. */
const minimumSpanMeters = 40;

export interface ChartPoint {
  readonly x: number;
  readonly y: number;
}

/** The live elevation profile drawn into a box (`UX-002`), with its scale for the axis labels. */
export interface ElevationShape {
  readonly line: string;
  readonly area: string;
  readonly last: ChartPoint;
  /** The point at the distance asked for, on the line; `null` when none was asked. */
  readonly marker: ChartPoint | null;
  readonly lowest: number;
  readonly highest: number;
  readonly meters: number;
}

function altitudeAt(points: readonly ElevationPoint[], distance: number): number {
  const after = points.findIndex((point) => point.distance >= distance);
  if (after <= 0) return (after === 0 ? points[0] : points[points.length - 1])?.altitude ?? 0;
  const left = points[after - 1];
  const right = points[after];
  if (left === undefined || right === undefined) return 0;
  const span = right.distance - left.distance;
  return span <= 0 ? right.altitude : left.altitude + ((right.altitude - left.altitude) * (distance - left.distance)) / span;
}

export function elevationShape(points: readonly ElevationPoint[], width: number, height: number, markerDistance: number | null = null): ElevationShape | null {
  const first = points[0];
  const final = points[points.length - 1];
  if (first === undefined || final === undefined || points.length < 2 || final.distance <= first.distance) return null;
  let lowest = Number.POSITIVE_INFINITY;
  let highest = Number.NEGATIVE_INFINITY;
  for (const point of points) {
    lowest = Math.min(lowest, point.altitude);
    highest = Math.max(highest, point.altitude);
  }
  const padding = Math.max(0, minimumSpanMeters - (highest - lowest)) / 2;
  const bottom = lowest - padding;
  const span = highest + padding - bottom;
  const toPoint = (point: ElevationPoint): ChartPoint => ({
    x: ((point.distance - first.distance) / (final.distance - first.distance)) * width,
    y: height - ((point.altitude - bottom) / span) * height,
  });
  const chart = points.map(toPoint);
  const line = chart.map((point, index) => `${index === 0 ? "M" : "L"}${point.x.toFixed(1)} ${point.y.toFixed(1)}`).join(" ");
  const last = chart[chart.length - 1] ?? { x: width, y: height };
  const at = markerDistance === null ? null : Math.min(Math.max(markerDistance, first.distance), final.distance);
  const marker = at === null ? null : toPoint({ distance: at, altitude: altitudeAt(points, at) });
  return { line, area: `${line} L${width} ${height} L0 ${height} Z`, last, marker, lowest, highest, meters: final.distance };
}
