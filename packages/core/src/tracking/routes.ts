import { and, eq, isNull } from "drizzle-orm";
import { route, sports } from "@obnixe/schema";
import type { BoundingBoxE7, ElevationSource, EpochMs, Id, Route, SportKey } from "@obnixe/schema";
import type { Environment, ObnixeDatabase } from "../database.ts";
import type { Mutation } from "../writer.ts";
import type { ProcessedTrack } from "./batch.ts";
import { decodePolyline, encodePolyline } from "./codec/polyline.ts";
import { encodeTrack, routeFilePath, trackDigest } from "./codec/track.ts";
import type { Track } from "./codec/track.ts";
import type { DemTiles } from "./dem.ts";
import { BoundingBoxBuilder, ellipsoidDistance } from "./geo.ts";
import type { GeoPoint } from "./geo.ts";
import { hasRouteAltitude, reverseRoutePath, RouteGeometry, routeProfile } from "./route.ts";
import type { RoutePath } from "./route.ts";
import { previewMaxPoints, previewToleranceMeters, simplifyPath } from "./simplify.ts";
import { absentValue, toSampleColumns } from "./types.ts";
import type { Fix } from "./types.ts";

/** A point closer than this to the previous one adds nothing to a route: stops leave no cluster of points. */
export const routePointSpacingMeters = 1;
/** Time between two points of a route file, whose fix stream needs increasing times (annex B). */
const routePointMs = 1000;

/** A point of a route as read from an activity or a file; orthometric altitude in mm. */
export interface RoutePoint {
  readonly latitudeE7: number;
  readonly longitudeE7: number;
  readonly altitudeMm: number | null;
}

/** The points in order, without those within `routePointSpacingMeters` of the previous one kept; the last point stays the end. */
export function routePathOf(points: readonly RoutePoint[]): RoutePath {
  const kept: RoutePoint[] = [];
  const near = (left: RoutePoint, right: RoutePoint): boolean =>
    ellipsoidDistance(left.latitudeE7 / 1e7, left.longitudeE7 / 1e7, right.latitudeE7 / 1e7, right.longitudeE7 / 1e7) < routePointSpacingMeters;
  for (const point of points) {
    const previous = kept[kept.length - 1];
    if (previous === undefined || !near(previous, point)) kept.push(point);
  }
  const last = points[points.length - 1];
  if (last !== undefined && kept.length > 1 && kept[kept.length - 1] !== last) kept[kept.length - 1] = last;
  return {
    length: kept.length,
    latitudeE7: Int32Array.from(kept, (point) => point.latitudeE7),
    longitudeE7: Int32Array.from(kept, (point) => point.longitudeE7),
    altitudeMm: Int32Array.from(kept, (point) => point.altitudeMm ?? absentValue),
  };
}

/** The path of an activity to redo (`RTE-001`) and how its altitude was measured. */
export interface ActivityRoute {
  readonly path: RoutePath;
  readonly elevationSource: ElevationSource;
}

/**
 * « Refaire ce parcours » (`RTE-001`): the smoothed positions and altitude of the trimmed activity, privacy zones not applied
 * since the route stays on the device.
 */
export function activityRoute(processed: Pick<ProcessedTrack, "series" | "summary">): ActivityRoute {
  const { series } = processed;
  const points: RoutePoint[] = [];
  for (let index = 0; index < series.length; index += 1) {
    const altitude = series.altitude[index] ?? Number.NaN;
    points.push({
      latitudeE7: Math.round((series.latitude[index] ?? 0) * 1e7),
      longitudeE7: Math.round((series.longitude[index] ?? 0) * 1e7),
      altitudeMm: Number.isNaN(altitude) ? null : Math.round(altitude * 1000),
    });
  }
  return { path: routePathOf(points), elevationSource: processed.summary.elevationSource };
}

/** The route file (`DEC-11`): an `.otrk` track with the fix stream only, positions and altitude as given. */
export function encodeRoutePath(path: RoutePath): Uint8Array {
  const fixes: Fix[] = [];
  for (let index = 0; index < path.length; index += 1) {
    const altitude = path.altitudeMm[index] ?? absentValue;
    fixes.push({
      type: "fix",
      t: index * routePointMs,
      fixAgeMs: 0,
      latitudeE7: path.latitudeE7[index] ?? 0,
      longitudeE7: path.longitudeE7[index] ?? 0,
      altitudeEllipsoidMm: null,
      altitudeMslMm: altitude === absentValue ? null : altitude,
      horizontalAccuracyDm: null,
      verticalAccuracyDm: null,
      speedCmS: null,
      speedAccuracyCmS: null,
      bearingCentiDeg: null,
      bearingAccuracyCentiDeg: null,
      simulated: false,
    });
  }
  return encodeTrack({ startedAt: 0 as EpochMs, samples: toSampleColumns(fixes), marks: [] });
}

/** A route without altitude given the DEM altitude of its points (`ELE-003`); `null` when a tile is missing. */
export function demRoutePath(path: RoutePath, tiles: DemTiles): RoutePath | null {
  const altitudeMm = new Int32Array(path.length);
  for (let index = 0; index < path.length; index += 1) {
    const altitude = tiles.altitudeAt((path.latitudeE7[index] ?? 0) / 1e7, (path.longitudeE7[index] ?? 0) / 1e7);
    if (altitude === null) return null;
    altitudeMm[index] = Math.round(altitude * 1000);
  }
  return { ...path, altitudeMm };
}

/** The path stored in a decoded route file, in the direction of the file. */
export function routePathOfTrack(track: Track): RoutePath {
  const { fixes } = track.samples;
  return { length: fixes.length, latitudeE7: fixes.latitudeE7.slice(), longitudeE7: fixes.longitudeE7.slice(), altitudeMm: fixes.altitudeMslMm.slice() };
}

/** The route as followed, from its decoded file. */
export function routeGeometryOf(row: Pick<Route, "reversed" | "elevationSource">, track: Track): RouteGeometry {
  const path = routePathOfTrack(track);
  return new RouteGeometry(row.reversed ? reverseRoutePath(path) : path, row.elevationSource);
}

/** The columns of a route row measured from its path in the direction it is followed (`RTE-001`, `RTE-002`). */
export interface RouteMeasure {
  readonly distanceMm: number;
  readonly ascentMm: number | null;
  readonly descentMm: number | null;
  readonly elevationSource: ElevationSource;
  readonly bbox: BoundingBoxE7;
  /** Polyline precision 5 at the preview tolerance and point budget (`GPS-070`). */
  readonly previewPolyline: string;
}

export function measureRoutePath(path: RoutePath, source: ElevationSource): RouteMeasure {
  const elevationSource = hasRouteAltitude(path) ? source : "none";
  const profile = routeProfile(path, elevationSource);
  const last = path.length - 1;
  const latitude = Float64Array.from(path.latitudeE7, (value) => value / 1e7);
  const longitude = Float64Array.from(path.longitudeE7, (value) => value / 1e7);
  const box = new BoundingBoxBuilder();
  for (let index = 0; index < path.length; index += 1) box.include(latitude[index] ?? 0, longitude[index] ?? 0);
  const bbox = box.build();
  if (bbox === null) throw new InvalidRouteError("length");
  const kept = simplifyPath(latitude, longitude, previewToleranceMeters, previewMaxPoints);
  const previewPolyline = encodePolyline(
    { length: kept.length, latitudeE7: Int32Array.from(kept, (index) => path.latitudeE7[index] ?? 0), longitudeE7: Int32Array.from(kept, (index) => path.longitudeE7[index] ?? 0) },
    5,
  );
  const meters = (column: Float64Array | null): number | null => (column === null ? null : Math.round((column[last] ?? 0) * 1000));
  return { distanceMm: Math.round((profile.distance[last] ?? 0) * 1000), ascentMm: meters(profile.ascent), descentMm: meters(profile.descent), elevationSource, bbox, previewPolyline };
}

export type RouteProblem = "name" | "sport" | "length";

export class InvalidRouteError extends Error {
  constructor(readonly problem: RouteProblem) {
    super(`Invalid route ${problem}`);
  }
}

export interface RouteDraft {
  readonly name: string;
  readonly sport: SportKey;
  readonly path: RoutePath;
  readonly elevationSource: ElevationSource;
  /** The activity redone, `null` for an imported file. */
  readonly sourceSessionId: Id | null;
}

/** A route is followed by a sport with a recording profile, and has two distinct points. */
export function routeProblem(draft: RouteDraft): RouteProblem | null {
  if (draft.name.trim() === "") return "name";
  if (sports[draft.sport].recording === null) return "sport";
  if (draft.path.length < 2 || (routeProfile(draft.path, "none").distance[draft.path.length - 1] ?? 0) <= 0) return "length";
  return null;
}

/** The route file, written and verified at `path` before the commit of the route row (`DAT-020`). */
export interface RouteFile {
  readonly path: string;
  readonly bytes: Uint8Array;
  readonly sha256: string;
}

export interface RoutePlan {
  readonly routeId: Id;
  readonly file: RouteFile;
  readonly mutation: Mutation;
}

/** `RTE-001`: the route row and its file; distance and D+ come from the engine, never from the file's totals. */
export function newRoute(env: Environment, draft: RouteDraft): RoutePlan {
  const problem = routeProblem(draft);
  if (problem !== null) throw new InvalidRouteError(problem);
  const routeId = env.newId();
  const bytes = encodeRoutePath(draft.path);
  const file: RouteFile = { path: routeFilePath(routeId), bytes, sha256: trackDigest(bytes) };
  return {
    routeId,
    file,
    mutation: {
      kind: "insert",
      table: "route",
      row: {
        id: routeId,
        name: draft.name.trim(),
        sport: draft.sport,
        ...measureRoutePath(draft.path, draft.elevationSource),
        reversed: false,
        trackFile: file.path,
        trackSha256: file.sha256,
        trackBytes: bytes.length,
        pointCount: draft.path.length,
        sourceSessionId: draft.sourceSessionId,
        lastUsedAt: null,
        deletedAt: null,
      },
    },
  };
}

export function renameRoute(row: Route, name: string): Mutation | null {
  const trimmed = name.trim();
  if (trimmed === "") throw new InvalidRouteError("name");
  if (trimmed === row.name) return null;
  return { kind: "update", table: "route", key: row.id, patch: { name: trimmed } };
}

/** `RTE-002`: the route followed the other way, its file untouched; D+ and D- are measured again in the new direction. */
export function reverseRoute(row: Route, track: Track): Mutation {
  const reversed = !row.reversed;
  const path = routePathOfTrack(track);
  const { elevationSource: _elevationSource, ...measure } = measureRoutePath(reversed ? reverseRoutePath(path) : path, row.elevationSource);
  return { kind: "update", table: "route", key: row.id, patch: { ...measure, reversed } };
}

export const routeOrders = ["recent", "name", "distance", "ascent"] as const;
export type RouteOrder = (typeof routeOrders)[number];

function compareRoutes(order: RouteOrder): (left: Route, right: Route) => number {
  const byName = (left: Route, right: Route): number => left.name.localeCompare(right.name, "fr", { sensitivity: "base" });
  switch (order) {
    case "recent":
      return (left, right) => (right.lastUsedAt ?? right.createdAt) - (left.lastUsedAt ?? left.createdAt) || byName(left, right);
    case "name":
      return byName;
    case "distance":
      return (left, right) => left.distanceMm - right.distanceMm || byName(left, right);
    case "ascent":
      return (left, right) => (left.ascentMm ?? Number.POSITIVE_INFINITY) - (right.ascentMm ?? Number.POSITIVE_INFINITY) || byName(left, right);
    default: {
      const unreachable: never = order;
      throw new Error(`Unhandled route order ${String(unreachable)}`);
    }
  }
}

/** The library (`RTE-002`), trashed routes excluded, of one sport for the preparation screen (`RTE-003`). Most recently used first for `recent`, ascending otherwise. */
export function routeLibrary(db: ObnixeDatabase, order: RouteOrder, sport: SportKey | null): readonly Route[] {
  const live = isNull(route.deletedAt);
  const rows = db
    .select()
    .from(route)
    .where(sport === null ? live : and(live, eq(route.sport, sport)))
    .all();
  return rows.sort(compareRoutes(order));
}

/** The start of the route as followed, from its preview, which keeps both ends. */
export function routeStart(row: Pick<Route, "previewPolyline">): GeoPoint {
  const decoded = decodePolyline(row.previewPolyline, 5);
  return { latitude: (decoded.latitudeE7[0] ?? 0) / 1e7, longitude: (decoded.longitudeE7[0] ?? 0) / 1e7 };
}

/** `RTE-003`: meters from the position to the start of the route. */
export function distanceToRouteStart(row: Pick<Route, "previewPolyline">, position: GeoPoint): number {
  const start = routeStart(row);
  return ellipsoidDistance(position.latitude, position.longitude, start.latitude, start.longitude);
}
