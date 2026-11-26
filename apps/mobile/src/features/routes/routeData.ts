import { eq } from "drizzle-orm";
import { activityRoute, decodeTrack, hasRouteAltitude, ImportError, lttb, newRoute, readRouteFile, RouteGeometry, routeGeometryOf, routePathOf, RouteTooShortError, simplifyPath, TrackDecodeError, trackDigest } from "@obnixe/core";
import type { ElevationPoint, ImportErrorReason, ProcessedTrack, RoutePath, RoutePlan, SportGuess } from "@obnixe/core";
import { route } from "@obnixe/schema";
import type { ElevationSource, Id, Route, SportKey } from "@obnixe/schema";
import { db, environment } from "@/data/database";
import { write } from "@/data/write";
import { importErrorMessage } from "@/features/activityFiles/importActivity";
import type { PreviewPath } from "@/features/activityFiles/importActivity";
import type { LngLat } from "@/features/maps/surface";
import type { GeoPoint } from "@/features/maps/tiles";
import { readTrack, writeRouteTrack } from "@/features/tracking/trackStore";

/** A route read from a file or an activity, measured by the engine before it is saved (`RTE-001`). */
export interface RouteCandidate {
  readonly name: string | null;
  readonly sport: SportGuess | null;
  readonly path: RoutePath;
  readonly elevationSource: ElevationSource;
  readonly geometry: RouteGeometry;
}

export type RouteReading = { readonly kind: "read"; readonly candidate: RouteCandidate } | { readonly kind: "refused"; readonly message: string };

const mapTolerance = 4;
const mapMaxPoints = 1500;
const profileMaxPoints = 300;

export function routeErrorMessage(reason: ImportErrorReason): string {
  switch (reason) {
    case "not_a_route":
    case "no_activity_data":
      return "Aucun itinéraire dans ce fichier : il faut une trace GPX, un parcours FIT ou TCX";
    case "several_activities":
      return "Ce fichier contient plusieurs itinéraires. Importe-les un par un.";
    case "unsupported_format":
      return "Format non pris en charge. Choisis un fichier GPX, TCX ou FIT.";
    case "malformed":
    case "checksum":
    case "truncated":
    case "not_an_activity":
    case "untimed":
    case "unordered_time":
    case "invalid_coordinates":
    case "invalid_value":
      return importErrorMessage(reason);
    default: {
      const unreachable: never = reason;
      return unreachable;
    }
  }
}

function candidateOf(name: string | null, sport: SportGuess | null, path: RoutePath, source: ElevationSource): RouteCandidate {
  const elevationSource = hasRouteAltitude(path) ? source : "none";
  return { name, sport, path, elevationSource, geometry: new RouteGeometry(path, elevationSource) };
}

/** A file's altitude is taken as given; without it the route has no D+ until the DEM is available. */
export function readRoute(bytes: Uint8Array): RouteReading {
  try {
    const file = readRouteFile(bytes);
    return { kind: "read", candidate: candidateOf(file.name, file.sport, routePathOf(file.points), "file") };
  } catch (error) {
    if (error instanceof ImportError) return { kind: "refused", message: routeErrorMessage(error.reason) };
    if (error instanceof RouteTooShortError) return { kind: "refused", message: routeErrorMessage("not_a_route") };
    throw error;
  }
}

/** « Refaire ce parcours » (`RTE-001`): the trimmed activity, privacy zones not applied; `null` when it does not move. */
export function activityCandidate(processed: ProcessedTrack, name: string, sport: SportKey): RouteCandidate | null {
  const { path, elevationSource } = activityRoute(processed);
  try {
    return candidateOf(name, { sport, values: {} }, path, elevationSource);
  } catch (error) {
    if (error instanceof RouteTooShortError) return null;
    throw error;
  }
}

/** Writes and verifies the file first (`DAT-020`), then commits the row that references it. */
export async function saveRoute(candidate: RouteCandidate, name: string, sport: SportKey, sourceSessionId: Id | null): Promise<RoutePlan> {
  const plan = newRoute(environment, { name, sport, path: candidate.path, elevationSource: candidate.elevationSource, sourceSessionId });
  await writeRouteTrack(plan.routeId, plan.file.bytes);
  write(`Itinéraire : ${name.trim()}`, [plan.mutation]);
  return plan;
}

export type RouteLoad = { readonly kind: "loaded"; readonly geometry: RouteGeometry } | { readonly kind: "missing" } | { readonly kind: "damaged" };

/** The route as followed, from its file checked against the row's digest. */
export async function loadRouteGeometry(row: Pick<Route, "trackFile" | "trackSha256" | "reversed" | "elevationSource">): Promise<RouteLoad> {
  const bytes = await readTrack(row.trackFile);
  if (bytes === null) return { kind: "missing" };
  if (trackDigest(bytes) !== row.trackSha256) return { kind: "damaged" };
  try {
    return { kind: "loaded", geometry: routeGeometryOf(row, decodeTrack(bytes)) };
  } catch (error) {
    if (error instanceof TrackDecodeError || error instanceof RouteTooShortError) return { kind: "damaged" };
    throw error;
  }
}

/** The whole route for a map, simplified to what a screen shows. */
export function routeMapPath(geometry: RouteGeometry): PreviewPath {
  const kept = simplifyPath(geometry.latitude, geometry.longitude, mapTolerance, mapMaxPoints);
  let west = Number.POSITIVE_INFINITY;
  let south = Number.POSITIVE_INFINITY;
  let east = Number.NEGATIVE_INFINITY;
  let north = Number.NEGATIVE_INFINITY;
  const coordinates = Array.from(kept, (index): LngLat => {
    const longitude = geometry.longitude[index] ?? 0;
    const latitude = geometry.latitude[index] ?? 0;
    west = Math.min(west, longitude);
    east = Math.max(east, longitude);
    south = Math.min(south, latitude);
    north = Math.max(north, latitude);
    return [longitude, latitude];
  });
  return { coordinates, bounds: [west, south, east, north] };
}

/** The route's altitude against its distance, reduced for a chart; empty without altitude. */
export function routeProfilePoints(geometry: RouteGeometry): readonly ElevationPoint[] {
  const { distance, altitude } = geometry.profile;
  if (altitude === null) return [];
  const xs: number[] = [];
  const ys: number[] = [];
  for (let index = 0; index < altitude.length; index += 1) {
    const value = altitude[index] ?? Number.NaN;
    if (Number.isNaN(value)) continue;
    xs.push(distance[index] ?? 0);
    ys.push(value);
  }
  return Array.from(lttb(xs, ys, profileMaxPoints), (index): ElevationPoint => ({ distance: xs[index] ?? 0, altitude: ys[index] ?? 0 }));
}

/** The corners of the route's extent, for an offline region around it (`RTE-006`). */
export function routeCorners(row: Pick<Route, "bbox">): readonly GeoPoint[] {
  const { south, west, north, east } = row.bbox;
  return [
    { latitude: south / 1e7, longitude: west / 1e7 },
    { latitude: north / 1e7, longitude: east / 1e7 },
  ];
}

export function routeById(routeId: Id): Route | null {
  return db().select().from(route).where(eq(route.id, routeId)).get() ?? null;
}
