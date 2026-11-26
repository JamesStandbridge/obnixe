import type { Id, SportKey } from "@obnixe/schema";
import type { ObnixeDatabase } from "../database.ts";
import { ellipsoidDistance, meridianRadius, parallelRadius } from "./geo.ts";
import type { EastNorth, GeoPoint } from "./geo.ts";
import type { LivePoint } from "./live.ts";
import { segmentSummaries } from "./segmentBoards.ts";
import { segmentFamilyOf, segmentRules, segmentShape } from "./segments.ts";
import type { SegmentShape } from "./segments.ts";

/** A known segment watched during a recording, with its best effort before it. */
export interface LiveSegmentTarget {
  readonly shape: SegmentShape;
  readonly name: string;
  readonly bestElapsedMs: number | null;
}

/** `SEG-004`: entering a segment, then the pass that ends it; `bestElapsedMs` is the best before this pass, this activity's included. */
export type LiveSegmentEvent =
  | { readonly kind: "segment_entered"; readonly segmentId: Id; readonly name: string; readonly bestElapsedMs: number | null }
  | { readonly kind: "segment_finished"; readonly segmentId: Id; readonly name: string; readonly elapsedMs: number; readonly bestElapsedMs: number | null };

/** The segments of the sport's family outside the trash, each with its best pass in force (`SEG-003`). */
export function liveSegmentTargets(db: ObnixeDatabase, sport: SportKey): readonly LiveSegmentTarget[] {
  const family = segmentFamilyOf(sport);
  if (family === null) return [];
  return segmentSummaries(db, family).map((summary) => ({ shape: segmentShape(summary.segment), name: summary.segment.name, bestElapsedMs: summary.best?.elapsedMs ?? null }));
}

/** At least twice `nearMeters`: the 3 x 3 cells around a point hold every probe within 50 m of it. */
const cellMeters = 50;
const nearSquared = segmentRules.nearMeters * segmentRules.nearMeters;
const radiansPerDegree = Math.PI / 180;
const cellKey = (column: number, row: number): number => (column + 32_768) * 65_536 + (row + 32_768);

interface PlanePoint {
  readonly x: number;
  readonly y: number;
}

/** A step of the live track between two display points, outside pauses and gaps. */
interface LiveEdge {
  readonly from: LivePoint;
  readonly to: LivePoint;
  /** Distance traveled on the live track up to `from`. */
  readonly fromDistance: number;
  readonly meters: number;
}

/** A pass that may be under way: from a start crossing, the probes covered since. */
interface Attempt {
  readonly startT: number;
  readonly startDistance: number;
  readonly covered: Uint8Array;
  coveredCount: number;
}

/** Fraction of the edge at its forward crossing of the line through `point` perpendicular to `direction`, within `nearMeters`. */
function crossing(a: PlanePoint, b: PlanePoint, point: PlanePoint, direction: EastNorth): number | null {
  const ax = a.x - point.x;
  const ay = a.y - point.y;
  const bx = b.x - point.x;
  const by = b.y - point.y;
  const before = ax * direction.east + ay * direction.north;
  const after = bx * direction.east + by * direction.north;
  if (!(before < 0 && after >= 0)) return null;
  const fraction = -before / (after - before);
  const lateral = (ax + (bx - ax) * fraction) * direction.north - (ay + (by - ay) * fraction) * direction.east;
  return Math.abs(lateral) <= segmentRules.nearMeters ? fraction : null;
}

function squaredDistanceToEdge(x: number, y: number, a: PlanePoint, b: PlanePoint): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length = dx * dx + dy * dy;
  const along = length === 0 ? 0 : Math.min(Math.max(((x - a.x) * dx + (y - a.y) * dy) / length, 0), 1);
  const ex = x - a.x - along * dx;
  const ey = y - a.y - along * dy;
  return ex * ex + ey * ey;
}

/** One segment on a plane tangent at its start, its probes indexed by `cellMeters` cells. */
class SegmentWatch {
  private readonly target: LiveSegmentTarget;
  private readonly eastScale: number;
  private readonly northScale: number;
  private readonly end: PlanePoint;
  private readonly probeX: Float64Array;
  private readonly probeY: Float64Array;
  private readonly cells = new Map<number, number[]>();
  private readonly seen: Uint32Array;
  private readonly required: number;
  private readonly shortest: number;
  private readonly longest: number;
  private stamp = 0;
  private attempts: Attempt[] = [];
  private best: number | null;

  constructor(target: LiveSegmentTarget) {
    const { shape } = target;
    this.target = target;
    this.best = target.bestElapsedMs;
    this.eastScale = parallelRadius(shape.start.latitude) * radiansPerDegree;
    this.northScale = meridianRadius(shape.start.latitude) * radiansPerDegree;
    this.end = this.project(shape.end);
    const { probes } = shape;
    this.probeX = new Float64Array(probes.length);
    this.probeY = new Float64Array(probes.length);
    this.seen = new Uint32Array(probes.length);
    for (let probe = 0; probe < probes.length; probe += 1) {
      const point = this.project({ latitude: probes.latitude[probe] ?? 0, longitude: probes.longitude[probe] ?? 0 });
      this.probeX[probe] = point.x;
      this.probeY[probe] = point.y;
      const key = cellKey(Math.floor(point.x / cellMeters), Math.floor(point.y / cellMeters));
      const cell = this.cells.get(key);
      if (cell === undefined) this.cells.set(key, [probe]);
      else cell.push(probe);
    }
    this.required = probes.length - Math.floor(probes.length * (1 - segmentRules.coverage));
    this.shortest = shape.meters * (1 - segmentRules.lengthTolerance);
    this.longest = shape.meters * (1 + segmentRules.lengthTolerance);
  }

  private project(point: GeoPoint): PlanePoint {
    const delta = point.longitude - this.target.shape.start.longitude;
    return { x: this.eastScale * (delta > 180 ? delta - 360 : delta < -180 ? delta + 360 : delta), y: this.northScale * (point.latitude - this.target.shape.start.latitude) };
  }

  /**
   * The `SEG-002` rules on the live track, one edge at a time: an end crossing closes the earliest attempt whose traveled
   * length and coverage pass, and every attempt with it; a start crossing opens one. An attempt longer than the tolerance goes.
   */
  advance(edge: LiveEdge, events: LiveSegmentEvent[]): void {
    const a = this.project(edge.from);
    const b = this.project(edge.to);
    const { id: segmentId } = this.target.shape;
    const { name } = this.target;
    if (this.attempts.length > 0) {
      this.cover(a, b);
      const fraction = crossing(a, b, this.end, this.target.shape.endHeading);
      if (fraction !== null) {
        const distance = edge.fromDistance + edge.meters * fraction;
        const pass = this.attempts.find((attempt) => distance - attempt.startDistance >= this.shortest && attempt.coveredCount >= this.required);
        if (pass !== undefined) {
          const elapsedMs = Math.round(edge.from.t + (edge.to.t - edge.from.t) * fraction - pass.startT);
          events.push({ kind: "segment_finished", segmentId, name, elapsedMs, bestElapsedMs: this.best });
          this.best = this.best === null ? elapsedMs : Math.min(this.best, elapsedMs);
          this.attempts = [];
        }
      }
      const reached = edge.fromDistance + edge.meters;
      this.attempts = this.attempts.filter((attempt) => reached - attempt.startDistance <= this.longest);
    }
    const fraction = crossing(a, b, { x: 0, y: 0 }, this.target.shape.startHeading);
    if (fraction === null) return;
    if (this.attempts.length === 0) events.push({ kind: "segment_entered", segmentId, name, bestElapsedMs: this.best });
    this.attempts.push({ startT: edge.from.t + (edge.to.t - edge.from.t) * fraction, startDistance: edge.fromDistance + edge.meters * fraction, covered: new Uint8Array(this.probeX.length), coveredCount: 0 });
    this.cover(a, b);
  }

  /** Marks the probes within `nearMeters` of the edge in every attempt. */
  private cover(a: PlanePoint, b: PlanePoint): void {
    this.stamp += 1;
    const pieces = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / cellMeters));
    for (let piece = 0; piece <= pieces; piece += 1) {
      const x = a.x + ((b.x - a.x) * piece) / pieces;
      const y = a.y + ((b.y - a.y) * piece) / pieces;
      const column = Math.floor(x / cellMeters);
      const row = Math.floor(y / cellMeters);
      for (let dx = -1; dx <= 1; dx += 1) {
        for (let dy = -1; dy <= 1; dy += 1) {
          for (const probe of this.cells.get(cellKey(column + dx, row + dy)) ?? []) {
            if (this.seen[probe] === this.stamp) continue;
            this.seen[probe] = this.stamp;
            if (squaredDistanceToEdge(this.probeX[probe] ?? 0, this.probeY[probe] ?? 0, a, b) > nearSquared) continue;
            for (const attempt of this.attempts) {
              if (attempt.covered[probe] === 1) continue;
              attempt.covered[probe] = 1;
              attempt.coveredCount += 1;
            }
          }
        }
      }
    }
  }
}

/**
 * `SEG-004`: follows the live track over the known segments and tells when one is entered and when a pass ends, with its
 * time and the best before it. The pass stored with the activity is measured again on the processed track (`SEG-002`).
 */
export class LiveSegmentWatch {
  private readonly watches: readonly SegmentWatch[];
  private previous: LivePoint | null = null;
  private distance = 0;

  constructor(targets: readonly LiveSegmentTarget[]) {
    this.watches = targets.map((target) => new SegmentWatch(target));
  }

  /** Takes the display points of the live track in order (`LiveTracker.takeTrack`); a dashed step is neither measured nor matched. */
  push(point: LivePoint): readonly LiveSegmentEvent[] {
    const from = this.previous;
    this.previous = point;
    if (from === null || point.dashed || this.watches.length === 0) return [];
    const meters = ellipsoidDistance(from.latitude, from.longitude, point.latitude, point.longitude);
    const edge: LiveEdge = { from, to: point, fromDistance: this.distance, meters };
    this.distance += meters;
    const events: LiveSegmentEvent[] = [];
    for (const watch of this.watches) watch.advance(edge, events);
    return events;
  }
}
