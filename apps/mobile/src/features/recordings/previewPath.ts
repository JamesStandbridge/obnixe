import { decodePolyline, PolylineDecodeError } from "@obnixe/core";
import type { DecodedPath } from "@obnixe/core";

export interface PreviewPoint {
  readonly x: number;
  readonly y: number;
}

/** A stored preview drawn in a `width` × `height` box: the path, its ends, kept in proportion and centered (`MAP-023`). */
export interface PreviewGeometry {
  readonly path: string;
  readonly start: PreviewPoint;
  readonly end: PreviewPoint;
}

const radiansPerDegree = Math.PI / 180;
const cache = new Map<string, PreviewGeometry | null>();
const cacheLimit = 400;

function build(polyline: string, width: number, height: number, inset: number): PreviewGeometry | null {
  let decoded: DecodedPath;
  try {
    decoded = decodePolyline(polyline, 5);
  } catch (error) {
    if (error instanceof PolylineDecodeError) return null;
    throw error;
  }
  if (decoded.length < 2) return null;
  let south = Infinity;
  let north = -Infinity;
  for (const value of decoded.latitudeE7) {
    south = Math.min(south, value);
    north = Math.max(north, value);
  }
  const cosine = Math.cos(((south + north) / 2e7) * radiansPerDegree);
  const xs = Float64Array.from(decoded.longitudeE7, (value) => value * cosine);
  let west = Infinity;
  let east = -Infinity;
  for (const value of xs) {
    west = Math.min(west, value);
    east = Math.max(east, value);
  }
  const spanX = Math.max(east - west, 1);
  const spanY = Math.max(north - south, 1);
  const scale = Math.min((width - 2 * inset) / spanX, (height - 2 * inset) / spanY);
  const offsetX = (width - spanX * scale) / 2;
  const offsetY = (height - spanY * scale) / 2;
  const at = (index: number): PreviewPoint => ({ x: offsetX + ((xs[index] ?? 0) - west) * scale, y: offsetY + (north - (decoded.latitudeE7[index] ?? 0)) * scale });
  let path = "";
  for (let index = 0; index < decoded.length; index += 1) {
    const point = at(index);
    path += `${index === 0 ? "M" : "L"}${point.x.toFixed(1)},${point.y.toFixed(1)}`;
  }
  return { path, start: at(0), end: at(decoded.length - 1) };
}

/** Memoized: list rows redraw the same previews while scrolling, with no network and no map (`SUM-010`). */
export function previewGeometry(polyline: string, width: number, height: number, inset: number): PreviewGeometry | null {
  const key = `${width}x${height}x${inset}:${polyline}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  const geometry = build(polyline, width, height, inset);
  if (cache.size >= cacheLimit) {
    const oldest = cache.keys().next();
    if (oldest.done !== true) cache.delete(oldest.value);
  }
  cache.set(key, geometry);
  return geometry;
}
