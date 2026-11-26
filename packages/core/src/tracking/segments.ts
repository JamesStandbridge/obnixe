import type { BoundingBoxE7, Id, Segment, SegmentEffort, SegmentFamily, SportKey } from "@obnixe/schema";
import type { Environment } from "../database.ts";
import type { Mutation } from "../writer.ts";
import type { ProcessedTrack } from "./batch.ts";
import { decodePolyline, encodePolyline } from "./codec/polyline.ts";
import { boxesOverlap, eastNorthBetween, ellipsoidDistance, expandBoundingBox, meridianRadius, parallelRadius } from "./geo.ts";
import type { EastNorth, GeoPoint } from "./geo.ts";
import type { TrackPositions } from "./privacy.ts";
import { simplifyPath } from "./simplify.ts";
import { intervalCodes, valueAt } from "./stages/derive.ts";
import type { TrackSeries } from "./stages/derive.ts";

/** `SEG-001` and `SEG-002`. */
export const segmentRules = {
  /** The track passes this close to the start, the end and the points of the segment. */
  nearMeters: 25,
  /** The traveled length stays within this share of the segment's length. */
  lengthTolerance: 0.1,
  /** Share of the segment's points the track passes near. */
  coverage: 0.9,
  /** Douglas-Peucker tolerance of the stored polyline. */
  toleranceMeters: 2,
  /** Also the `segment_distance` check. */
  minMeters: 100,
} as const;

/** Coverage is checked at the vertices and at points this far apart in between, so long straight edges count for their length. */
const probeSpacingMeters = 10;
/** The direction of the segment at each end, which orients the crossing lines, is taken over this length. */
const headingMeters = 20;
/** At least twice `nearMeters`: the 3 x 3 cells around a point hold every track point within 50 m of it. */
const cellMeters = 50;
/** Edges longer than this may pass near a point with both ends outside its 3 x 3 cells; they are split by virtual points. */
const maxIndexedEdgeMeters = cellMeters;
/** Edges tried from the one that served the previous probe before searching the cells. */
const hintEdges = 8;
const nearSquared = segmentRules.nearMeters * segmentRules.nearMeters;
const radiansPerDegree = Math.PI / 180;

/** The sports whose efforts are compared on a segment of each family; the others never get efforts. */
export function segmentFamilyOf(sport: SportKey): SegmentFamily | null {
  switch (sport) {
    case "run":
    case "trail":
    case "walk":
    case "hike":
      return "foot";
    case "bike":
      return "bike";
    case "strength":
    case "swim":
    case "climb":
    case "yoga":
      return null;
    default: {
      const unreachable: never = sport;
      throw new Error(`Unknown sport ${String(unreachable)}`);
    }
  }
}

/** A segment decoded once for matching against any number of activities. */
export interface SegmentShape {
  readonly id: Id;
  readonly family: SegmentFamily;
  readonly bbox: BoundingBoxE7;
  readonly meters: number;
  readonly start: GeoPoint;
  readonly end: GeoPoint;
  /** Unit directions of travel at the start and at the end: each crossing line is perpendicular to its direction. */
  readonly startHeading: EastNorth;
  readonly endHeading: EastNorth;
  /** The vertices and the points between them at `probeSpacingMeters`, checked for coverage. */
  readonly probes: TrackPositions;
}

export type SegmentPass = Omit<SegmentEffort, "sessionId">;

function decodeSegmentPath(polyline: string): TrackPositions {
  const decoded = decodePolyline(polyline, 6);
  return {
    length: decoded.length,
    latitude: Float64Array.from(decoded.latitudeE7, (value) => value / 1e7),
    longitude: Float64Array.from(decoded.longitudeE7, (value) => value / 1e7),
  };
}

function pointAt(path: TrackPositions, index: number): GeoPoint {
  return { latitude: path.latitude[index] ?? 0, longitude: path.longitude[index] ?? 0 };
}

/** The point `meters` along the path from its first point, or from its last when `backward`. */
function pointAlong(path: TrackPositions, meters: number, backward: boolean): GeoPoint {
  const last = path.length - 1;
  const step = backward ? -1 : 1;
  let index = backward ? last : 0;
  let walked = 0;
  while (index + step >= 0 && index + step <= last) {
    const from = pointAt(path, index);
    const to = pointAt(path, index + step);
    const length = ellipsoidDistance(from.latitude, from.longitude, to.latitude, to.longitude);
    if (walked + length >= meters && length > 0) {
      const fraction = (meters - walked) / length;
      return { latitude: from.latitude + (to.latitude - from.latitude) * fraction, longitude: from.longitude + (to.longitude - from.longitude) * fraction };
    }
    walked += length;
    index += step;
  }
  return pointAt(path, backward ? 0 : last);
}

function heading(from: GeoPoint, to: GeoPoint): EastNorth {
  const offset = eastNorthBetween(from.latitude, from.longitude, to.latitude, to.longitude);
  const length = Math.hypot(offset.east, offset.north);
  return length === 0 ? { east: 0, north: 1 } : { east: offset.east / length, north: offset.north / length };
}

function probesOf(path: TrackPositions): TrackPositions {
  const latitude: number[] = [];
  const longitude: number[] = [];
  const count = path.length;
  for (let index = 0; index < count; index += 1) {
    const from = pointAt(path, index);
    latitude.push(from.latitude);
    longitude.push(from.longitude);
    if (index === count - 1) break;
    const to = pointAt(path, index + 1);
    const pieces = Math.ceil(ellipsoidDistance(from.latitude, from.longitude, to.latitude, to.longitude) / probeSpacingMeters);
    for (let piece = 1; piece < pieces; piece += 1) {
      latitude.push(from.latitude + ((to.latitude - from.latitude) * piece) / pieces);
      longitude.push(from.longitude + ((to.longitude - from.longitude) * piece) / pieces);
    }
  }
  return { length: latitude.length, latitude: Float64Array.from(latitude), longitude: Float64Array.from(longitude) };
}

export function segmentShape(row: Pick<Segment, "id" | "family" | "polyline" | "distanceMm" | "bbox">): SegmentShape {
  const path = decodeSegmentPath(row.polyline);
  const meters = row.distanceMm / 1000;
  const start = pointAt(path, 0);
  const end = pointAt(path, path.length - 1);
  const reach = Math.min(headingMeters, meters / 4);
  const ahead = pointAlong(path, reach, false);
  const behind = pointAlong(path, reach, true);
  return {
    id: row.id,
    family: row.family,
    bbox: row.bbox,
    meters,
    start,
    end,
    startHeading: heading(start, ahead),
    endHeading: heading(behind, end),
    probes: probesOf(path),
  };
}

/** The decoded polyline of a segment, in degrees. */
export function segmentPath(row: Pick<Segment, "polyline">): TrackPositions {
  return decodeSegmentPath(row.polyline);
}

/** The prefilter of `SEG-005`: a segment can only be passed by an activity whose box, grown by `nearMeters`, overlaps its own. */
export function segmentSearchBox(activity: BoundingBoxE7): BoundingBoxE7 {
  return expandBoundingBox(activity, segmentRules.nearMeters);
}

interface Crossing {
  /** Fractional index into the series. */
  readonly at: number;
}

const cellKey = (column: number, row: number): number => (column + 32_768) * 65_536 + (row + 32_768);

/**
 * One activity projected once on a plane tangent at its middle latitude, its points indexed by `cellMeters` cells. The
 * projection error stays under a meter at 25 m for activities spanning less than about two degrees of latitude.
 */
class ActivityIndex {
  private readonly x: Float64Array;
  private readonly y: Float64Array;
  private readonly cells = new Map<number, number[]>();
  private readonly seen: Uint32Array;
  private stamp = 0;
  private readonly referenceLatitude: number;
  private readonly referenceLongitude: number;
  private readonly eastScale: number;
  private readonly northScale: number;

  constructor(private readonly series: TrackSeries) {
    const { length, latitude, longitude } = series;
    let south = Number.POSITIVE_INFINITY;
    let north = Number.NEGATIVE_INFINITY;
    for (let index = 0; index < length; index += 1) {
      const value = latitude[index] ?? 0;
      if (value < south) south = value;
      if (value > north) north = value;
    }
    this.referenceLatitude = (south + north) / 2;
    this.referenceLongitude = longitude[0] ?? 0;
    this.eastScale = parallelRadius(this.referenceLatitude) * radiansPerDegree;
    this.northScale = meridianRadius(this.referenceLatitude) * radiansPerDegree;
    this.x = new Float64Array(length);
    this.y = new Float64Array(length);
    this.seen = new Uint32Array(length);
    for (let index = 0; index < length; index += 1) {
      this.x[index] = this.projectX(longitude[index] ?? 0);
      this.y[index] = this.projectY(latitude[index] ?? 0);
      this.index(this.x[index] ?? 0, this.y[index] ?? 0, index);
      if (index === 0) continue;
      const gap = Math.hypot((this.x[index] ?? 0) - (this.x[index - 1] ?? 0), (this.y[index] ?? 0) - (this.y[index - 1] ?? 0));
      const pieces = Math.ceil(gap / maxIndexedEdgeMeters);
      for (let piece = 1; piece < pieces; piece += 1) {
        const fraction = piece / pieces;
        this.index((this.x[index - 1] ?? 0) + ((this.x[index] ?? 0) - (this.x[index - 1] ?? 0)) * fraction, (this.y[index - 1] ?? 0) + ((this.y[index] ?? 0) - (this.y[index - 1] ?? 0)) * fraction, index);
      }
    }
  }

  projectX(longitude: number): number {
    const delta = longitude - this.referenceLongitude;
    return this.eastScale * (delta > 180 ? delta - 360 : delta < -180 ? delta + 360 : delta);
  }

  projectY(latitude: number): number {
    return this.northScale * (latitude - this.referenceLatitude);
  }

  private index(x: number, y: number, point: number): void {
    const key = cellKey(Math.floor(x / cellMeters), Math.floor(y / cellMeters));
    const cell = this.cells.get(key);
    if (cell === undefined) this.cells.set(key, [point]);
    else if (cell[cell.length - 1] !== point) cell.push(point);
  }

  /** Every edge (from its start index) with an end in the 3 x 3 cells around the point, once, gaps excluded. */
  private edgesNear(x: number, y: number): number[] {
    this.stamp += 1;
    const column = Math.floor(x / cellMeters);
    const row = Math.floor(y / cellMeters);
    const edges: number[] = [];
    for (let dx = -1; dx <= 1; dx += 1) {
      for (let dy = -1; dy <= 1; dy += 1) {
        const cell = this.cells.get(cellKey(column + dx, row + dy));
        if (cell === undefined) continue;
        for (const point of cell) {
          for (let edge = point - 1; edge <= point; edge += 1) {
            if (edge < 0 || edge >= this.series.length - 1 || this.seen[edge] === this.stamp) continue;
            this.seen[edge] = this.stamp;
            if (this.series.interval[edge + 1] !== intervalCodes.gap) edges.push(edge);
          }
        }
      }
    }
    return edges;
  }

  /**
   * Forward crossings of the line through `point` perpendicular to `direction`, within `nearMeters` of the point, in track
   * order (`SEG-002`).
   */
  crossings(point: GeoPoint, direction: EastNorth): Crossing[] {
    const px = this.projectX(point.longitude);
    const py = this.projectY(point.latitude);
    const crossings: Crossing[] = [];
    for (const edge of this.edgesNear(px, py)) {
      const ax = (this.x[edge] ?? 0) - px;
      const ay = (this.y[edge] ?? 0) - py;
      const bx = (this.x[edge + 1] ?? 0) - px;
      const by = (this.y[edge + 1] ?? 0) - py;
      const before = ax * direction.east + ay * direction.north;
      const after = bx * direction.east + by * direction.north;
      if (!(before < 0 && after >= 0)) continue;
      const fraction = -before / (after - before);
      const lateral = (ax + (bx - ax) * fraction) * direction.north - (ay + (by - ay) * fraction) * direction.east;
      if (Math.abs(lateral) <= segmentRules.nearMeters) crossings.push({ at: edge + fraction });
    }
    return crossings.sort((left, right) => left.at - right.at);
  }

  /**
   * Whether the edges between the two crossings pass near enough of the probes (`SEG-002`). Probes follow the track, so the
   * edge that served the previous probe and the next few are tried before the cells.
   */
  covers(probes: TrackPositions, from: number, to: number): boolean {
    const count = probes.length;
    const allowed = Math.floor(count * (1 - segmentRules.coverage));
    const first = Math.floor(from);
    const last = Math.ceil(to);
    let hint = first;
    let missed = 0;
    for (let probe = 0; probe < count; probe += 1) {
      const qx = this.projectX(probes.longitude[probe] ?? 0);
      const qy = this.projectY(probes.latitude[probe] ?? 0);
      const near = this.nearFrom(qx, qy, hint, Math.min(hint + hintEdges, last)) ?? this.nearInCells(qx, qy, first, last);
      if (near === null) {
        if (++missed > allowed) return false;
      } else hint = near;
    }
    return true;
  }

  /** The first counted edge of `[from, to)` within `nearMeters` of the point, or null. */
  private nearFrom(qx: number, qy: number, from: number, to: number): number | null {
    for (let edge = from; edge < to; edge += 1) if (this.isNear(qx, qy, edge)) return edge;
    return null;
  }

  private nearInCells(qx: number, qy: number, from: number, to: number): number | null {
    const column = Math.floor(qx / cellMeters);
    const row = Math.floor(qy / cellMeters);
    for (let dx = -1; dx <= 1; dx += 1) {
      for (let dy = -1; dy <= 1; dy += 1) {
        const cell = this.cells.get(cellKey(column + dx, row + dy));
        if (cell === undefined) continue;
        for (const point of cell) {
          if (point - 1 >= from && point - 1 < to && this.isNear(qx, qy, point - 1)) return point - 1;
          if (point >= from && point < to && this.isNear(qx, qy, point)) return point;
        }
      }
    }
    return null;
  }

  private isNear(qx: number, qy: number, edge: number): boolean {
    return this.series.interval[edge + 1] !== intervalCodes.gap && this.squaredDistanceToEdge(qx, qy, edge) <= nearSquared;
  }

  private squaredDistanceToEdge(qx: number, qy: number, edge: number): number {
    const ax = this.x[edge] ?? 0;
    const ay = this.y[edge] ?? 0;
    const dx = (this.x[edge + 1] ?? 0) - ax;
    const dy = (this.y[edge + 1] ?? 0) - ay;
    const length = dx * dx + dy * dy;
    const along = length === 0 ? 0 : Math.min(Math.max(((qx - ax) * dx + (qy - ay) * dy) / length, 0), 1);
    const ex = qx - ax - along * dx;
    const ey = qy - ay - along * dy;
    return ex * ex + ey * ey;
  }
}

function passBetween(processed: Pick<ProcessedTrack, "series" | "elapsed" | "algorithmVersion">, segmentId: Id, occurrence: number, from: number, to: number): SegmentPass {
  const { series } = processed;
  const delta = (column: Float64Array): number => valueAt(column, to) - valueAt(column, from);
  const startT = valueAt(series.t, from);
  const coveredMs = series.heartRateMs === null ? 0 : delta(series.heartRateMs);
  const beats = series.heartBeats === null ? 0 : delta(series.heartBeats);
  return {
    segmentId,
    occurrence,
    startOffsetMs: Math.round(startT - processed.elapsed.startMs),
    elapsedMs: Math.round(valueAt(series.t, to) - startT),
    movingMs: Math.round(delta(series.moving)),
    heartRateAvg: coveredMs > 0 ? Math.round((beats * 60_000) / coveredMs) : null,
    algorithmVersion: processed.algorithmVersion,
  };
}

/**
 * `SEG-002`: every pass of the activity over each segment, in track order. A pass runs from a forward crossing of the start
 * line to the first forward crossing of the end line whose traveled distance is within the length tolerance and whose track
 * covers the segment; the next pass may start where it ended, so a loop ridden three times gives three passes and a segment
 * ridden backwards gives none. The caller keeps to the segments of the activity's family whose box overlaps its own.
 */
export function segmentPasses(processed: Pick<ProcessedTrack, "series" | "elapsed" | "algorithmVersion">, shapes: readonly SegmentShape[]): readonly SegmentPass[] {
  const { series } = processed;
  if (shapes.length === 0 || series.length < 2) return [];
  const activity = new ActivityIndex(series);
  const passes: SegmentPass[] = [];
  for (const shape of shapes) {
    const starts = activity.crossings(shape.start, shape.startHeading);
    if (starts.length === 0) continue;
    const ends = activity.crossings(shape.end, shape.endHeading);
    if (ends.length === 0) continue;
    const shortest = shape.meters * (1 - segmentRules.lengthTolerance);
    const longest = shape.meters * (1 + segmentRules.lengthTolerance);
    let occurrence = 0;
    let earliest = Number.NEGATIVE_INFINITY;
    for (const start of starts) {
      const startDistance = valueAt(series.distance, start.at);
      if (startDistance < earliest) continue;
      for (const end of ends) {
        if (end.at <= start.at) continue;
        const endDistance = valueAt(series.distance, end.at);
        const traveled = endDistance - startDistance;
        if (traveled < shortest) continue;
        if (traveled > longest) break;
        if (!activity.covers(shape.probes, start.at, end.at)) continue;
        passes.push(passBetween(processed, shape.id, occurrence, start.at, end.at));
        occurrence += 1;
        earliest = endDistance - segmentRules.nearMeters;
        break;
      }
    }
  }
  return passes;
}

/** The segments an activity in this box and sport may pass: the bounding-box prefilter of `SEG-005`. */
export function candidateShapes(shapes: readonly SegmentShape[], sport: SportKey, bbox: BoundingBoxE7 | null): readonly SegmentShape[] {
  const family = segmentFamilyOf(sport);
  if (family === null || bbox === null) return [];
  const box = segmentSearchBox(bbox);
  return shapes.filter((shape) => shape.family === family && boxesOverlap(box, shape.bbox));
}

/** A stretch of an activity, as fractional indices into its processed series. */
export interface SeriesRange {
  readonly from: number;
  readonly to: number;
}

export interface SegmentMeasure {
  readonly distanceMm: number;
  readonly ascentMm: number;
}

/** Distance and D+ of the stretch, as they are stored on the segment (`SEG-001`). */
export function measureRange(series: TrackSeries, hasElevation: boolean, range: SeriesRange): SegmentMeasure {
  const delta = (column: Float64Array): number => valueAt(column, range.to) - valueAt(column, range.from);
  return { distanceMm: Math.round(delta(series.distance) * 1000), ascentMm: hasElevation ? Math.round(delta(series.ascent) * 1000) : 0 };
}

export interface SegmentDraft {
  readonly name: string;
  readonly sport: SportKey;
  readonly sessionId: Id;
  readonly range: SeriesRange;
}

export type SegmentProblem = "name" | "sport" | "length";

export class InvalidSegmentError extends Error {
  constructor(readonly problem: SegmentProblem) {
    super(`Invalid segment ${problem}`);
  }
}

export interface SegmentPlan {
  readonly segmentId: Id;
  readonly mutation: Mutation;
}

export function segmentProblem(series: TrackSeries, draft: SegmentDraft): SegmentProblem | null {
  if (draft.name.trim() === "") return "name";
  if (segmentFamilyOf(draft.sport) === null) return "sport";
  const { from, to } = draft.range;
  if (!(from >= 0 && to > from && to <= series.length - 1)) return "length";
  if (measureRange(series, false, draft.range).distanceMm < segmentRules.minMeters * 1000) return "length";
  return null;
}

/** The track between the two ends, interpolated at both, simplified at `toleranceMeters`. */
function rangePath(series: TrackSeries, range: SeriesRange): TrackPositions {
  const latitude = [valueAt(series.latitude, range.from)];
  const longitude = [valueAt(series.longitude, range.from)];
  for (let index = Math.floor(range.from) + 1; index < range.to; index += 1) {
    latitude.push(series.latitude[index] ?? 0);
    longitude.push(series.longitude[index] ?? 0);
  }
  latitude.push(valueAt(series.latitude, range.to));
  longitude.push(valueAt(series.longitude, range.to));
  const kept = simplifyPath(latitude, longitude, segmentRules.toleranceMeters);
  return { length: kept.length, latitude: Float64Array.from(kept, (index) => latitude[index] ?? 0), longitude: Float64Array.from(kept, (index) => longitude[index] ?? 0) };
}

/** A coordinate as polyline precision 6 keeps it, in 1e-7 degree, so the stored box holds the decoded points exactly. */
const storedE7 = (degrees: number): number => Math.round(degrees * 1e6) * 10;

/** `SEG-001`: the segment drawn from a stretch of the activity, with its family from the activity's sport. */
export function newSegment(env: Environment, series: TrackSeries, hasElevation: boolean, draft: SegmentDraft): SegmentPlan {
  const problem = segmentProblem(series, draft);
  if (problem !== null) throw new InvalidSegmentError(problem);
  const family = segmentFamilyOf(draft.sport);
  if (family === null) throw new InvalidSegmentError("sport");
  const path = rangePath(series, draft.range);
  const latitudeE7 = Int32Array.from(path.latitude, storedE7);
  const longitudeE7 = Int32Array.from(path.longitude, storedE7);
  const bbox = { south: Math.min(...latitudeE7), west: Math.min(...longitudeE7), north: Math.max(...latitudeE7), east: Math.max(...longitudeE7) };
  const segmentId = env.newId();
  return {
    segmentId,
    mutation: {
      kind: "insert",
      table: "segment",
      row: {
        id: segmentId,
        name: draft.name.trim(),
        family,
        polyline: encodePolyline({ length: path.length, latitudeE7, longitudeE7 }, 6),
        ...measureRange(series, hasElevation, draft.range),
        bbox,
        south: bbox.south,
        north: bbox.north,
        sourceSessionId: draft.sessionId,
        deletedAt: null,
      },
    },
  };
}

export function renameSegment(segment: Segment, name: string): Mutation | null {
  const trimmed = name.trim();
  if (trimmed === "") throw new InvalidSegmentError("name");
  if (trimmed === segment.name) return null;
  return { kind: "update", table: "segment", key: segment.id, patch: { name: trimmed } };
}
