import { intervalCodes, locate, locateTime, maskTrack, robustRange, simplifyPath, valueAt } from "@obnixe/core";
import type { HeartRateZoneBounds, LapSummary, PointRange, PrivacyMask, ProcessedTrack, ValueRange } from "@obnixe/core";
import type { Bounds } from "@/features/maps/tiles";

/** How the detail map colors the track (`MAP-021`): along the activity, or by a metric with robust bounds. */
export type TrackColoring = "progress" | "pace" | "speed" | "grade" | "altitude" | "heart_rate";

export const mapToleranceMeters = 2;
export const mapMaxPoints = 4000;

/** Quantization of the colored values: consecutive points of one level share a feature. */
const levels = 24;
const maxChunkPoints = 120;

/** Track geometry of the detail map, computed once per processing and masking. */
export interface TrackGeometry {
  /** Series indices drawn, sorted; interrupted stretches keep only their ends. */
  readonly kept: Uint32Array;
  /** Per point of `kept`: whether the stretch that reaches it is interrupted (pause, bridge, gap) and drawn dashed. */
  readonly interruptedBefore: Uint8Array;
  /** Per point of `kept`: whether it starts a new visible run, after a hidden part of the track. */
  readonly runStart: Uint8Array;
  readonly visible: readonly PointRange[];
  /** Per series entry: 1 where the mask hides it. */
  readonly hidden: Uint8Array | null;
  readonly bounds: Bounds | null;
}

const isInterrupted = (code: number): boolean => code === intervalCodes.paused || code === intervalCodes.bridged || code === intervalCodes.gap;

/** Visible ranges of the series: everything unless the detail is masked too (`PRV-010`, `Q-18`). */
export function trackGeometry(processed: Pick<ProcessedTrack, "series">, mask: PrivacyMask | null): TrackGeometry {
  const { series } = processed;
  const masked = mask === null ? null : maskTrack(series, mask.zones, mask);
  const visible: readonly PointRange[] = masked === null ? (series.length === 0 ? [] : [{ start: 0, end: series.length }]) : masked.visible;
  const significant = simplifyPath(series.latitude, series.longitude, mapToleranceMeters, mapMaxPoints);
  const keep = new Uint8Array(series.length);
  for (const index of significant) keep[index] = 1;
  for (let index = 1; index < series.length; index += 1) {
    if (!isInterrupted(series.interval[index] ?? 0)) continue;
    keep[index - 1] = 1;
    keep[index] = 1;
    while (index + 1 < series.length && isInterrupted(series.interval[index + 1] ?? 0)) {
      keep[index] = 0;
      index += 1;
      keep[index] = 1;
    }
  }
  const kept: number[] = [];
  const interruptedBefore: number[] = [];
  const runStart: number[] = [];
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  for (const { start, end } of visible) {
    let first = true;
    for (let index = start; index < end; index += 1) {
      if (keep[index] !== 1 && index !== start && index !== end - 1) continue;
      const previous = kept.at(-1);
      kept.push(index);
      runStart.push(first ? 1 : 0);
      interruptedBefore.push(!first && previous !== undefined && isInterrupted(series.interval[index] ?? 0) && isInterrupted(series.interval[previous + 1] ?? 0) ? 1 : 0);
      first = false;
      const latitude = series.latitude[index] ?? 0;
      const longitude = series.longitude[index] ?? 0;
      west = Math.min(west, longitude);
      east = Math.max(east, longitude);
      south = Math.min(south, latitude);
      north = Math.max(north, latitude);
    }
  }
  return {
    kept: Uint32Array.from(kept),
    interruptedBefore: Uint8Array.from(interruptedBefore),
    runStart: Uint8Array.from(runStart),
    visible,
    hidden: masked?.hidden ?? null,
    bounds: kept.length === 0 ? null : [west, south, east, north],
  };
}

/** Values of a coloring scaled to [0, 1] on the robust bounds, or a heart-rate zone 0 to 5. */
export interface ColorScale {
  readonly kind: "ramp" | "zones";
  readonly range: ValueRange;
}

/** Average of `values` over the series entries `(from, to]`, by prefix sums, so a colored chunk shows its stretch. */
class RangeAverage {
  private readonly sums: Float64Array;
  private readonly counts: Uint32Array;

  constructor(values: ArrayLike<number>) {
    this.sums = new Float64Array(values.length + 1);
    this.counts = new Uint32Array(values.length + 1);
    for (let index = 0; index < values.length; index += 1) {
      const value = values[index] ?? Number.NaN;
      const known = Number.isFinite(value);
      this.sums[index + 1] = (this.sums[index] ?? 0) + (known ? value : 0);
      this.counts[index + 1] = (this.counts[index] ?? 0) + (known ? 1 : 0);
    }
  }

  of(from: number, to: number): number {
    const count = (this.counts[to + 1] ?? 0) - (this.counts[from + 1] ?? 0);
    return count === 0 ? Number.NaN : ((this.sums[to + 1] ?? 0) - (this.sums[from + 1] ?? 0)) / count;
  }
}

/** The scale of a metric column (`MAP-021`): percentiles 5 and 95, symmetric around zero for the grade. */
export function colorScale(coloring: Exclude<TrackColoring, "progress" | "heart_rate">, values: ArrayLike<number>): ColorScale | null {
  const range = robustRange(values);
  if (range === null || range.max <= range.min) return null;
  if (coloring !== "grade") return { kind: "ramp", range };
  const extent = Math.min(0.3, Math.max(0.03, Math.abs(range.min), Math.abs(range.max)));
  return { kind: "ramp", range: { min: -extent, max: extent } };
}

function zoneIndex(bpm: number, zones: readonly HeartRateZoneBounds[]): number {
  let zone = 0;
  for (const bounds of zones) if (bpm >= bounds.minBpm) zone = bounds.zone;
  return zone;
}

const coordinate = (degrees: number): string => degrees.toFixed(6);

function point(latitude: number, longitude: number): string {
  return `[${coordinate(longitude)},${coordinate(latitude)}]`;
}

function feature(properties: string, geometry: string): string {
  return `{"type":"Feature","properties":{${properties}},"geometry":${geometry}}`;
}

function collection(features: readonly string[]): string {
  return `{"type":"FeatureCollection","features":[${features.join(",")}]}`;
}

/** What a colored chunk carries: `v` in [0, 1] on a ramp, or the zone 0 to 5; `NaN` where unknown. */
export type ChunkValue = (from: number, to: number) => number;

/** `v` of a chunk without a known value, drawn in a neutral tone. */
export const unknownValue = -1;

/**
 * The `track` chunks, each with its color value `v`, and the dashed `interrupted` stretches: one GeoJSON collection whose chunks
 * break where the quantized value changes.
 */
export function trackLines(processed: Pick<ProcessedTrack, "series">, geometry: TrackGeometry, value: ChunkValue): string {
  const { series } = processed;
  const { kept } = geometry;
  const features: string[] = [];
  let chunk: string[] = [];
  let chunkLevel = unknownValue;
  const flush = (): void => {
    if (chunk.length > 1) features.push(feature(`"kind":"track","v":${chunkLevel}`, `{"type":"LineString","coordinates":[${chunk.join(",")}]}`));
    chunk = [];
  };
  for (let position = 0; position < kept.length; position += 1) {
    const index = kept[position] ?? 0;
    const here = point(series.latitude[index] ?? 0, series.longitude[index] ?? 0);
    if (geometry.runStart[position] === 1) {
      flush();
      chunk = [here];
      continue;
    }
    const previous = kept[position - 1] ?? 0;
    const there = point(series.latitude[previous] ?? 0, series.longitude[previous] ?? 0);
    if (geometry.interruptedBefore[position] === 1) {
      flush();
      features.push(feature(`"kind":"interrupted"`, `{"type":"LineString","coordinates":[${there},${here}]}`));
      chunk = [here];
      continue;
    }
    const raw = value(previous, index);
    const level = Number.isFinite(raw) ? Math.round(raw * levels) / levels : unknownValue;
    if (chunk.length === 0) chunk = [there];
    if (chunk.length > 1 && (level !== chunkLevel || chunk.length >= maxChunkPoints)) {
      flush();
      chunk = [there];
    }
    chunkLevel = level;
    chunk.push(here);
  }
  flush();
  return collection(features);
}

/** The value of a chunk: its share of the distance for `progress`. */
export function progressValue(processed: Pick<ProcessedTrack, "series">): ChunkValue {
  const { distance } = processed.series;
  const total = distance[distance.length - 1] ?? 0;
  return (_from, to) => (total <= 0 ? 0 : (distance[to] ?? 0) / total);
}

/** The value of a chunk: the average of the metric over its stretch, on the scale. */
export function metricValue(values: ArrayLike<number>, scale: ColorScale, zones: readonly HeartRateZoneBounds[]): ChunkValue {
  const average = new RangeAverage(values);
  return (from, to) => {
    const mean = average.of(from, to);
    if (!Number.isFinite(mean)) return Number.NaN;
    if (scale.kind === "zones") return zoneIndex(mean, zones);
    return Math.min(1, Math.max(0, (mean - scale.range.min) / (scale.range.max - scale.range.min)));
  };
}

/** Kilometer stones (`MAP-020`): every km, every 5 km on an activity longer than 30 km. */
export function kilometerStep(totalMeters: number): number {
  return totalMeters > 30_000 ? 5000 : 1000;
}

export interface MarkerPoint {
  readonly latitude: number;
  readonly longitude: number;
}

function hiddenAt(geometry: TrackGeometry, index: number): boolean {
  return geometry.hidden !== null && geometry.hidden[Math.round(index)] === 1;
}

function pointAt(processed: Pick<ProcessedTrack, "series">, index: number): MarkerPoint {
  return { latitude: valueAt(processed.series.latitude, index), longitude: valueAt(processed.series.longitude, index) };
}

/** The `start`, `finish`, `km` stones with their `label`, and the `lap` marks with their number, outside the masked parts. */
export function trackMarks(processed: Pick<ProcessedTrack, "series" | "elapsed">, laps: readonly Pick<LapSummary, "bounds">[], geometry: TrackGeometry): string {
  const { series } = processed;
  const features: string[] = [];
  const first = geometry.kept[0];
  const last = geometry.kept[geometry.kept.length - 1];
  const total = series.distance[series.length - 1] ?? 0;
  const step = kilometerStep(total);
  let from = 0;
  for (let meters = step; meters < total - step / 4; meters += step) {
    const index = locate(series.distance, meters, from);
    from = index;
    if (hiddenAt(geometry, index)) continue;
    const at = pointAt(processed, index);
    features.push(feature(`"kind":"km","label":"${meters / 1000}"`, `{"type":"Point","coordinates":${point(at.latitude, at.longitude)}}`));
  }
  if (laps.length > 1) {
    laps.slice(1).forEach((lap, offset) => {
      const index = locateTime(series.t, processed.elapsed.startMs + lap.bounds.startOffsetMs);
      if (hiddenAt(geometry, index)) return;
      const at = pointAt(processed, index);
      features.push(feature(`"kind":"lap","label":"${offset + 2}"`, `{"type":"Point","coordinates":${point(at.latitude, at.longitude)}}`));
    });
  }
  if (first !== undefined && last !== undefined) {
    features.push(feature(`"kind":"finish"`, `{"type":"Point","coordinates":${point(series.latitude[last] ?? 0, series.longitude[last] ?? 0)}}`));
    features.push(feature(`"kind":"start"`, `{"type":"Point","coordinates":${point(series.latitude[first] ?? 0, series.longitude[first] ?? 0)}}`));
  }
  return collection(features);
}

export const emptyCollection = collection([]);

/** The cursor mark at a fractional series index, absent in a masked part. */
export function cursorPoint(processed: Pick<ProcessedTrack, "series">, geometry: TrackGeometry, index: number | null): string {
  if (index === null || hiddenAt(geometry, index)) return emptyCollection;
  const at = pointAt(processed, index);
  return collection([feature(`"kind":"cursor"`, `{"type":"Point","coordinates":${point(at.latitude, at.longitude)}}`)]);
}

const metersPerDegree = 111_320;

/**
 * Uniform grid over the drawn points (`MAP-022`): a touch looks up its cell and the neighbouring ones, so finding the nearest
 * point costs the few points around it, whatever the length of the track.
 */
export class TrackIndex {
  private readonly cells = new Map<number, number[]>();
  private readonly cellMeters: number;
  private readonly cosine: number;
  private readonly origin: MarkerPoint;

  constructor(
    private readonly processed: Pick<ProcessedTrack, "series">,
    private readonly kept: Uint32Array,
    cellMeters = 60,
  ) {
    const { latitude, longitude } = processed.series;
    const first = kept[0] ?? 0;
    this.origin = { latitude: latitude[first] ?? 0, longitude: longitude[first] ?? 0 };
    this.cosine = Math.cos((this.origin.latitude * Math.PI) / 180);
    this.cellMeters = cellMeters;
    for (const index of kept) {
      const key = this.keyOf(this.cellOf(latitude[index] ?? 0, longitude[index] ?? 0));
      const list = this.cells.get(key);
      if (list === undefined) this.cells.set(key, [index]);
      else list.push(index);
    }
  }

  private project(latitude: number, longitude: number): MarkerPoint {
    return { latitude: (latitude - this.origin.latitude) * metersPerDegree, longitude: (longitude - this.origin.longitude) * metersPerDegree * this.cosine };
  }

  private cellOf(latitude: number, longitude: number): MarkerPoint {
    const projected = this.project(latitude, longitude);
    return { latitude: Math.floor(projected.latitude / this.cellMeters), longitude: Math.floor(projected.longitude / this.cellMeters) };
  }

  private keyOf(cell: MarkerPoint): number {
    return (cell.latitude + 32_768) * 65_536 + (cell.longitude + 32_768);
  }

  /** The series index of the drawn point nearest to a touch, `null` when none lies within `toleranceMeters`. */
  nearest(latitude: number, longitude: number, toleranceMeters: number): number | null {
    const touch = this.project(latitude, longitude);
    const center = this.cellOf(latitude, longitude);
    const reach = Math.ceil(toleranceMeters / this.cellMeters);
    const { series } = this.processed;
    let best: number | null = null;
    let bestDistance = toleranceMeters * toleranceMeters;
    for (let dy = -reach; dy <= reach; dy += 1) {
      for (let dx = -reach; dx <= reach; dx += 1) {
        for (const index of this.cells.get(this.keyOf({ latitude: center.latitude + dy, longitude: center.longitude + dx })) ?? []) {
          const at = this.project(series.latitude[index] ?? 0, series.longitude[index] ?? 0);
          const distance = (at.latitude - touch.latitude) ** 2 + (at.longitude - touch.longitude) ** 2;
          if (distance <= bestDistance) {
            bestDistance = distance;
            best = index;
          }
        }
      }
    }
    return best;
  }
}
