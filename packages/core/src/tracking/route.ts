import type { ElevationSource } from "@obnixe/schema";
import { eastNorthBetween, ellipsoidDistance, meridianRadius, parallelRadius } from "./geo.ts";
import type { GeoPoint } from "./geo.ts";
import { distanceMovingAverage, ElevationHysteresis, elevationThresholdMeters } from "./stages/altitude.ts";
import { absentValue } from "./types.ts";

/** `RTE-004` and `RTE-005`, in meters and milliseconds. */
export const routeMatching = {
  /** The search window around the last accepted progress. */
  behindMeters: 200,
  aheadMeters: 500,
  /** A projection farther than this is no match. */
  matchMeters: 50,
  /** Without a match in the window for this long, the search covers the whole route. */
  lostMs: 30_000,
  cellMeters: 100,
  /** Off the route beyond `max(offRouteMeters, 2 sigma)` for `offRouteMs`, back within `backOnRouteMeters` for `backOnRouteMs`. */
  offRouteMeters: 40,
  offRouteMs: 10_000,
  backOnRouteMeters: 25,
  backOnRouteMs: 5_000,
} as const;

/**
 * Meters of cost per meter between a projection's progress and the progress expected from the distance moved since the last
 * match: where the route passes twice, it keeps the match on the stretch being followed.
 */
const continuityWeight = 0.5;
/** Below this speed in m/s the direction of travel is unknown. */
const headingSpeed = 0.5;
const radiansPerDegree = Math.PI / 180;

/** A route as stored in its file (`DEC-11`): positions in 1e-7 degree, orthometric altitude in mm, `absentValue` where unknown. */
export interface RoutePath {
  readonly length: number;
  readonly latitudeE7: Int32Array;
  readonly longitudeE7: Int32Array;
  readonly altitudeMm: Int32Array;
}

export function reverseRoutePath(path: RoutePath): RoutePath {
  return { length: path.length, latitudeE7: path.latitudeE7.slice().reverse(), longitudeE7: path.longitudeE7.slice().reverse(), altitudeMm: path.altitudeMm.slice().reverse() };
}

export function hasRouteAltitude(path: RoutePath): boolean {
  return path.altitudeMm.some((value) => value !== absentValue);
}

/**
 * The hysteresis threshold of the route's altitude (`ELE-010`): a route drawn from an activity keeps the altitude of its
 * source, a file's altitude is measured like an imported activity's.
 */
export function routeElevationThreshold(source: ElevationSource): number | null {
  switch (source) {
    case "barometer":
      return elevationThresholdMeters.barometer;
    case "gnss":
    case "file":
      return elevationThresholdMeters.gnss;
    case "none":
      return null;
    default: {
      const unreachable: never = source;
      throw new Error(`Unhandled elevation source ${String(unreachable)}`);
    }
  }
}

/** Cumulative measures at each point of a route path, in meters. */
export interface RouteProfile {
  readonly distance: Float64Array;
  /** Altitude as measured, `NaN` where unknown; `null` without altitude. */
  readonly altitude: Float64Array | null;
  readonly ascent: Float64Array | null;
  readonly descent: Float64Array | null;
}

/**
 * Distance along the path (`GPS-036`) and D+ and D- by the hysteresis automaton (`ELE-010`). A file's raw altitude is first
 * averaged over distance like an imported activity's; an activity's altitude is already smoothed.
 */
export function routeProfile(path: RoutePath, source: ElevationSource): RouteProfile {
  const { length } = path;
  const distance = new Float64Array(length);
  for (let index = 1; index < length; index += 1) {
    distance[index] =
      (distance[index - 1] ?? 0) +
      ellipsoidDistance((path.latitudeE7[index - 1] ?? 0) / 1e7, (path.longitudeE7[index - 1] ?? 0) / 1e7, (path.latitudeE7[index] ?? 0) / 1e7, (path.longitudeE7[index] ?? 0) / 1e7);
  }
  const threshold = routeElevationThreshold(source);
  const known: number[] = [];
  for (let index = 0; index < length; index += 1) if (path.altitudeMm[index] !== absentValue) known.push(index);
  if (threshold === null || known.length === 0) return { distance, altitude: null, ascent: null, descent: null };
  const measured = Float64Array.from(known, (index) => (path.altitudeMm[index] ?? 0) / 1000);
  const values = source === "file" ? distanceMovingAverage(Float64Array.from(known, (index) => distance[index] ?? 0), measured) : measured;
  const altitude = new Float64Array(length).fill(Number.NaN);
  known.forEach((index, position) => (altitude[index] = values[position] ?? Number.NaN));
  const ascent = new Float64Array(length);
  const descent = new Float64Array(length);
  const hysteresis = new ElevationHysteresis(threshold);
  for (let index = 0; index < length; index += 1) {
    const value = altitude[index] ?? Number.NaN;
    if (!Number.isNaN(value)) hysteresis.push(value, true);
    ascent[index] = hysteresis.ascent;
    descent[index] = hysteresis.descent;
  }
  return { distance, altitude, ascent, descent };
}

export class RouteTooShortError extends Error {
  constructor(readonly points: number) {
    super(`A route needs two distinct points, it has ${points}`);
  }
}

const cellKey = (column: number, row: number): number => (column + 32_768) * 65_536 + (row + 32_768);

/** The nearest point of one edge of the route to a position. */
interface Projection {
  readonly edge: number;
  /** Along the edge, from 0 to 1. */
  readonly fraction: number;
  /** Meters from the start of the route. */
  readonly progress: number;
  /** Meters from the position. */
  readonly distance: number;
}

/**
 * A route decoded once for following (`RTE-004`): its profile, its points on a plane tangent at its middle latitude, and its
 * edges indexed by `routeMatching.cellMeters` cells. Progress is measured along the ellipsoid; the plane only places a
 * position on an edge, with an error under a meter at 50 m for routes spanning less than two degrees of latitude.
 */
export class RouteGeometry {
  readonly length: number;
  readonly latitude: Float64Array;
  readonly longitude: Float64Array;
  readonly profile: RouteProfile;
  private readonly x: Float64Array;
  private readonly y: Float64Array;
  private readonly cells = new Map<number, number[]>();
  private readonly referenceLatitude: number;
  private readonly referenceLongitude: number;
  private readonly eastScale: number;
  private readonly northScale: number;

  constructor(path: RoutePath, source: ElevationSource) {
    const { length } = path;
    this.profile = routeProfile(path, source);
    if (length < 2 || (this.profile.distance[length - 1] ?? 0) <= 0) throw new RouteTooShortError(length);
    this.length = length;
    this.latitude = Float64Array.from(path.latitudeE7, (value) => value / 1e7);
    this.longitude = Float64Array.from(path.longitudeE7, (value) => value / 1e7);
    let south = Number.POSITIVE_INFINITY;
    let north = Number.NEGATIVE_INFINITY;
    for (const value of this.latitude) {
      if (value < south) south = value;
      if (value > north) north = value;
    }
    this.referenceLatitude = (south + north) / 2;
    this.referenceLongitude = this.longitude[0] ?? 0;
    this.eastScale = parallelRadius(this.referenceLatitude) * radiansPerDegree;
    this.northScale = meridianRadius(this.referenceLatitude) * radiansPerDegree;
    this.x = Float64Array.from(this.longitude, (value) => this.projectX(value));
    this.y = Float64Array.from(this.latitude, (value) => this.projectY(value));
    for (let edge = 0; edge < length - 1; edge += 1) this.indexEdge(edge);
  }

  /** Length of the route in meters. */
  get meters(): number {
    return this.profile.distance[this.length - 1] ?? 0;
  }

  /** D+ of the route in meters, `null` without altitude. */
  get ascent(): number | null {
    return this.profile.ascent === null ? null : (this.profile.ascent[this.length - 1] ?? 0);
  }

  get edges(): number {
    return this.length - 1;
  }

  /** Meters from the start of the route to the start of the edge. */
  edgeStart(edge: number): number {
    return this.profile.distance[edge] ?? 0;
  }

  edgeEnd(edge: number): number {
    return this.profile.distance[edge + 1] ?? 0;
  }

  /** The edge that contains the progress, by binary search. */
  edgeAt(progress: number): number {
    let low = 0;
    let high = this.length - 2;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if (this.edgeStart(middle) <= progress) low = middle;
      else high = middle - 1;
    }
    return low;
  }

  pointAt(progress: number): GeoPoint {
    const edge = this.edgeAt(progress);
    const span = this.edgeEnd(edge) - this.edgeStart(edge);
    return this.pointOnEdge(edge, span <= 0 ? 0 : Math.min(Math.max((progress - this.edgeStart(edge)) / span, 0), 1));
  }

  pointOnEdge(edge: number, fraction: number): GeoPoint {
    const latitude = this.latitude[edge] ?? 0;
    const longitude = this.longitude[edge] ?? 0;
    return { latitude: latitude + ((this.latitude[edge + 1] ?? latitude) - latitude) * fraction, longitude: longitude + ((this.longitude[edge + 1] ?? longitude) - longitude) * fraction };
  }

  /** D+ from the start of the route to the progress, `null` without altitude. */
  ascentAt(progress: number): number | null {
    const ascent = this.profile.ascent;
    if (ascent === null) return null;
    const edge = this.edgeAt(progress);
    const span = this.edgeEnd(edge) - this.edgeStart(edge);
    const fraction = span <= 0 ? 0 : Math.min(Math.max((progress - this.edgeStart(edge)) / span, 0), 1);
    const from = ascent[edge] ?? 0;
    return from + ((ascent[edge + 1] ?? from) - from) * fraction;
  }

  projectX(longitude: number): number {
    const delta = longitude - this.referenceLongitude;
    return this.eastScale * (delta > 180 ? delta - 360 : delta < -180 ? delta + 360 : delta);
  }

  projectY(latitude: number): number {
    return this.northScale * (latitude - this.referenceLatitude);
  }

  /** The nearest point of the edge to the projected position, no nearer to the start of the edge than `minimumFraction`. */
  project(edge: number, qx: number, qy: number, minimumFraction: number = 0): Projection {
    const ax = this.x[edge] ?? 0;
    const ay = this.y[edge] ?? 0;
    const dx = (this.x[edge + 1] ?? 0) - ax;
    const dy = (this.y[edge + 1] ?? 0) - ay;
    const squared = dx * dx + dy * dy;
    const fraction = Math.min(Math.max(squared === 0 ? 0 : ((qx - ax) * dx + (qy - ay) * dy) / squared, minimumFraction), 1);
    const start = this.edgeStart(edge);
    return { edge, fraction, progress: start + (this.edgeEnd(edge) - start) * fraction, distance: Math.hypot(qx - ax - fraction * dx, qy - ay - fraction * dy) };
  }

  /** Whether moving along the velocity follows the edge in the route's direction. */
  follows(edge: number, velocityEast: number, velocityNorth: number): boolean {
    return ((this.x[edge + 1] ?? 0) - (this.x[edge] ?? 0)) * velocityEast + ((this.y[edge + 1] ?? 0) - (this.y[edge] ?? 0)) * velocityNorth > 0;
  }

  /**
   * Every edge with a point, an end or one of the virtual points every cell along it, in the 3 x 3 cells around the position:
   * each edge passing within half a cell of it, in O(m) for m indexed edges (`RTE-007`).
   */
  edgesNear(qx: number, qy: number): readonly number[] {
    const column = Math.floor(qx / routeMatching.cellMeters);
    const row = Math.floor(qy / routeMatching.cellMeters);
    const edges = new Set<number>();
    for (let dx = -1; dx <= 1; dx += 1) {
      for (let dy = -1; dy <= 1; dy += 1) {
        for (const edge of this.cells.get(cellKey(column + dx, row + dy)) ?? []) edges.add(edge);
      }
    }
    return [...edges];
  }

  private indexEdge(edge: number): void {
    const ax = this.x[edge] ?? 0;
    const ay = this.y[edge] ?? 0;
    const bx = this.x[edge + 1] ?? 0;
    const by = this.y[edge + 1] ?? 0;
    const pieces = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / routeMatching.cellMeters));
    for (let piece = 0; piece <= pieces; piece += 1) {
      const fraction = piece / pieces;
      const key = cellKey(Math.floor((ax + (bx - ax) * fraction) / routeMatching.cellMeters), Math.floor((ay + (by - ay) * fraction) / routeMatching.cellMeters));
      const cell = this.cells.get(key);
      if (cell === undefined) this.cells.set(key, [edge]);
      else if (cell[cell.length - 1] !== edge) cell.push(edge);
    }
  }
}

/** A smoothed position of the live tracker: degrees, meters of horizontal accuracy and m/s. */
export interface RouteFix {
  readonly t: number;
  readonly latitude: number;
  readonly longitude: number;
  readonly accuracy: number | null;
  readonly velocityEast: number;
  readonly velocityNorth: number;
}

/** Where to rejoin the route while off it (`RTE-005`): its nearest point downstream, in meters and degrees from north. */
export interface RouteRejoin {
  readonly latitude: number;
  readonly longitude: number;
  readonly progress: number;
  readonly distance: number;
  readonly bearing: number;
}

/** The follow of a route (`RTE-003`), in meters. */
export interface RouteProgress {
  /** Some position matched the route already: before, progress is 0 and nothing is off the route. */
  readonly joined: boolean;
  /** The latest position matched the route. */
  readonly matched: boolean;
  readonly progress: number;
  readonly remaining: number;
  /** Progress over the route's length, from 0 to 1. */
  readonly fraction: number;
  /** `null` without altitude. */
  readonly remainingAscent: number | null;
  /** From the latest position to the route, `null` when no edge was searched near it. */
  readonly distance: number | null;
  readonly offRoute: boolean;
  /** Only while off the route. */
  readonly rejoin: RouteRejoin | null;
}

export type RouteEvent = { readonly type: "off_route"; readonly t: number } | { readonly type: "back_on_route"; readonly t: number };

/**
 * Follows a route from the smoothed positions (`RTE-004`, `RTE-005`), O(k) per position for the k edges of the window, the
 * whole-route search O(m) through the cells (`RTE-007`). The progress only moves on a match: by the projection of least
 * distance plus `continuityWeight` times its gap to the expected progress in the window, by the nearest projection in the
 * direction of travel after `lostMs` without one, and before the first by the nearest projection on the first stretch of the
 * route within reach, so a loop starts at its start rather than its end.
 */
export class RouteMatcher {
  private joined = false;
  private matched = false;
  private progress = 0;
  private distance: number | null = null;
  private rejoin: RouteRejoin | null = null;
  private last: GeoPoint | null = null;
  private lostSince: number | null = null;
  private windowEdge = 0;
  private offRoute = false;
  private crossingSince: number | null = null;

  constructor(readonly route: RouteGeometry) {}

  get state(): RouteProgress {
    const { route } = this;
    const ascent = route.ascent;
    const ascentAt = route.ascentAt(this.progress);
    return {
      joined: this.joined,
      matched: this.matched,
      progress: this.progress,
      remaining: Math.max(route.meters - this.progress, 0),
      fraction: Math.min(Math.max(this.progress / route.meters, 0), 1),
      remainingAscent: ascent === null || ascentAt === null ? null : Math.max(ascent - ascentAt, 0),
      distance: this.distance,
      offRoute: this.offRoute,
      rejoin: this.offRoute ? this.rejoin : null,
    };
  }

  push(fix: RouteFix): RouteEvent | null {
    const { route } = this;
    const qx = route.projectX(fix.longitude);
    const qy = route.projectY(fix.latitude);
    let nearest = Number.POSITIVE_INFINITY;
    let match: Projection | null = null;
    let downstream: Projection | null = null;
    if (this.joined) {
      const expected = this.progress + (this.last === null ? 0 : ellipsoidDistance(this.last.latitude, this.last.longitude, fix.latitude, fix.longitude));
      let bestCost = Number.POSITIVE_INFINITY;
      const until = this.progress + routeMatching.aheadMeters;
      for (let edge = this.firstWindowEdge(); edge < route.edges && route.edgeStart(edge) <= until; edge += 1) {
        const projection = route.project(edge, qx, qy);
        if (projection.distance < nearest) nearest = projection.distance;
        if (projection.distance <= routeMatching.matchMeters) {
          const cost = projection.distance + continuityWeight * Math.abs(projection.progress - expected);
          if (cost < bestCost) {
            bestCost = cost;
            match = projection;
          }
        }
        if (route.edgeEnd(edge) < this.progress) continue;
        const span = route.edgeEnd(edge) - route.edgeStart(edge);
        const ahead = route.project(edge, qx, qy, span <= 0 ? 0 : Math.max((this.progress - route.edgeStart(edge)) / span, 0));
        if (downstream === null || ahead.distance < downstream.distance) downstream = ahead;
      }
    }
    if (match === null) {
      this.lostSince ??= fix.t;
      if (!this.joined || fix.t - this.lostSince >= routeMatching.lostMs) {
        const search = this.searchCells(qx, qy, fix);
        if (search.nearest < nearest) nearest = search.nearest;
        match = search.match;
        if (match !== null) this.windowEdge = route.edgeAt(Math.max(match.progress - routeMatching.behindMeters, 0));
      }
    }
    this.matched = match !== null;
    if (match !== null) {
      this.joined = true;
      this.progress = match.progress;
      this.last = { latitude: fix.latitude, longitude: fix.longitude };
      this.lostSince = null;
    }
    this.distance = Number.isFinite(nearest) ? nearest : null;
    this.rejoin = downstream === null ? null : this.rejoinOf(downstream, fix);
    return this.joined ? this.watchOffRoute(fix) : null;
  }

  /** The first edge ending after `progress - behindMeters`, walked from the previous one. */
  private firstWindowEdge(): number {
    const { route } = this;
    const from = this.progress - routeMatching.behindMeters;
    while (this.windowEdge > 0 && route.edgeStart(this.windowEdge) >= from) this.windowEdge -= 1;
    while (this.windowEdge < route.edges - 1 && route.edgeEnd(this.windowEdge) < from) this.windowEdge += 1;
    return this.windowEdge;
  }

  private searchCells(qx: number, qy: number, fix: RouteFix): { readonly match: Projection | null; readonly nearest: number } {
    const { route } = this;
    const moving = Math.hypot(fix.velocityEast, fix.velocityNorth) >= headingSpeed;
    let nearest = Number.POSITIVE_INFINITY;
    let first: Projection | null = null;
    let closest: Projection | null = null;
    let along: Projection | null = null;
    const candidates: Projection[] = [];
    for (const edge of route.edgesNear(qx, qy)) {
      const projection = route.project(edge, qx, qy);
      if (projection.distance < nearest) nearest = projection.distance;
      if (projection.distance > routeMatching.matchMeters) continue;
      candidates.push(projection);
      if (first === null || projection.progress < first.progress) first = projection;
      if (closest === null || projection.distance < closest.distance) closest = projection;
      if (moving && route.follows(edge, fix.velocityEast, fix.velocityNorth) && (along === null || projection.distance < along.distance)) along = projection;
    }
    if (this.joined || first === null) return { match: along ?? closest, nearest };
    const stretchEnd = first.progress + 2 * routeMatching.matchMeters;
    let start: Projection = first;
    for (const projection of candidates) if (projection.progress <= stretchEnd && projection.distance < start.distance) start = projection;
    return { match: start, nearest };
  }

  private rejoinOf(projection: Projection, fix: RouteFix): RouteRejoin {
    const point = this.route.pointOnEdge(projection.edge, projection.fraction);
    const offset = eastNorthBetween(fix.latitude, fix.longitude, point.latitude, point.longitude);
    const bearing = (Math.atan2(offset.east, offset.north) / radiansPerDegree + 360) % 360;
    return { latitude: point.latitude, longitude: point.longitude, progress: projection.progress, distance: projection.distance, bearing };
  }

  private watchOffRoute(fix: RouteFix): RouteEvent | null {
    const distance = this.distance ?? Number.POSITIVE_INFINITY;
    const crossing = this.offRoute ? distance < routeMatching.backOnRouteMeters : distance > Math.max(routeMatching.offRouteMeters, 2 * (fix.accuracy ?? 0));
    if (!crossing) {
      this.crossingSince = null;
      return null;
    }
    this.crossingSince ??= fix.t;
    if (fix.t - this.crossingSince < (this.offRoute ? routeMatching.backOnRouteMs : routeMatching.offRouteMs)) return null;
    this.offRoute = !this.offRoute;
    this.crossingSince = null;
    return { type: this.offRoute ? "off_route" : "back_on_route", t: fix.t };
  }
}
