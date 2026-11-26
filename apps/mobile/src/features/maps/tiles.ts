import type { OfflineCoverage, ZoomRange } from "@/features/maps/styles";

/** West, south, east, north in degrees. */
export type Bounds = readonly [number, number, number, number];

export interface RegionEstimate {
  readonly tiles: number;
  readonly bytes: number;
}

export interface GeoPoint {
  readonly latitude: number;
  readonly longitude: number;
}

/** Above this, a download would take too long on the free tile services; the screen asks for a smaller area. */
export const maxRegionTiles = 20_000;

const kilobyte = 1024;

/** Mean tile weights measured on OpenFreeMap and Terrain Tiles over mountain, rural and urban France, in KiB. */
const vectorTileKiB: Readonly<Record<number, number>> = { 5: 400, 6: 320, 7: 320, 8: 250, 9: 200, 10: 130, 11: 100, 12: 100, 13: 90, 14: 120 };
const reliefTileKiB: Readonly<Record<number, number>> = { 5: 80, 6: 78, 7: 78, 8: 78, 9: 130, 10: 130, 11: 125, 12: 115 };

const maxLatitude = 85.051129;

function tileX(longitude: number, zoom: number): number {
  return Math.floor(((longitude + 180) / 360) * 2 ** zoom);
}

function tileY(latitude: number, zoom: number): number {
  const clamped = (Math.max(-maxLatitude, Math.min(maxLatitude, latitude)) * Math.PI) / 180;
  return Math.floor(((1 - Math.log(Math.tan(clamped) + 1 / Math.cos(clamped)) / Math.PI) / 2) * 2 ** zoom);
}

export function tileCount([west, south, east, north]: Bounds, zoom: number): number {
  const last = 2 ** zoom - 1;
  const columns = Math.min(last, tileX(east, zoom)) - Math.max(0, tileX(west, zoom)) + 1;
  const rows = Math.min(last, tileY(south, zoom)) - Math.max(0, tileY(north, zoom)) + 1;
  return Math.max(0, columns) * Math.max(0, rows);
}

function estimateRange(bounds: Bounds, range: ZoomRange, weights: Readonly<Record<number, number>>): RegionEstimate {
  let tiles = 0;
  let bytes = 0;
  for (let zoom = range.min; zoom <= range.max; zoom += 1) {
    const count = tileCount(bounds, zoom);
    tiles += count;
    bytes += count * (weights[zoom] ?? 0) * kilobyte;
  }
  return { tiles, bytes };
}

/** Tile count and expected size of an offline region (MAP-031), shown before the download starts. */
export function estimateRegion(bounds: Bounds, coverage: OfflineCoverage): RegionEstimate {
  const vector = estimateRange(bounds, coverage.vector, vectorTileKiB);
  if (coverage.relief === null) return vector;
  const relief = estimateRange(bounds, coverage.relief, reliefTileKiB);
  return { tiles: vector.tiles + relief.tiles, bytes: vector.bytes + relief.bytes };
}

const metersPerDegreeLatitude = 111_320;

/** Bounding box of points widened by a buffer on every side, for a region around an activity or a route. */
export function bufferedBounds(points: readonly GeoPoint[], bufferMeters: number): Bounds | null {
  if (points.length === 0) return null;
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  for (const { latitude, longitude } of points) {
    west = Math.min(west, longitude);
    east = Math.max(east, longitude);
    south = Math.min(south, latitude);
    north = Math.max(north, latitude);
  }
  const latitudePad = bufferMeters / metersPerDegreeLatitude;
  const widest = Math.max(Math.abs(south), Math.abs(north)) + latitudePad;
  const longitudePad = bufferMeters / (metersPerDegreeLatitude * Math.cos((Math.min(widest, maxLatitude) * Math.PI) / 180));
  return [Math.max(-180, west - longitudePad), Math.max(-maxLatitude, south - latitudePad), Math.min(180, east + longitudePad), Math.min(maxLatitude, north + latitudePad)];
}
