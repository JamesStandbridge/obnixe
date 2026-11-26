import type { MapCamera } from "@/features/maps/surface";
import type { Bounds } from "@/features/maps/tiles";

export interface ViewSize {
  readonly width: number;
  readonly height: number;
}

/** MapLibre lays the world on 512 px tiles, natively and on the web: at zoom z the equator is 512 * 2^z px long. */
const tilePixels = 512;
const equatorMeters = 2 * Math.PI * 6_378_137;
const maxLatitude = 85.051129;
const radiansPerDegree = Math.PI / 180;

/** Ground meters covered by one screen pixel at the center of a Web Mercator view. */
export function metersPerPixel(latitude: number, zoom: number): number {
  return (equatorMeters * Math.cos(latitude * radiansPerDegree)) / (tilePixels * 2 ** zoom);
}

function mercatorX(longitude: number): number {
  return (longitude + 180) / 360;
}

function mercatorY(latitude: number): number {
  const angle = Math.max(-maxLatitude, Math.min(maxLatitude, latitude)) * radiansPerDegree;
  return (1 - Math.log(Math.tan(angle) + 1 / Math.cos(angle)) / Math.PI) / 2;
}

function latitudeAt(y: number): number {
  return Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) / radiansPerDegree;
}

/** The camera showing `bounds` whole in a view of `size`, keeping `padding` px free on every side, zoomed in at most to `maxZoom`. */
export function fitCamera(bounds: Bounds, size: ViewSize, padding: number, maxZoom: number): MapCamera {
  const [west, south, east, north] = bounds;
  const top = mercatorY(north);
  const bottom = mercatorY(south);
  const width = Math.max(1, size.width - 2 * padding) / ((mercatorX(east) - mercatorX(west)) * tilePixels);
  const height = Math.max(1, size.height - 2 * padding) / ((bottom - top) * tilePixels);
  return { center: [(west + east) / 2, latitudeAt((top + bottom) / 2)], zoom: Math.min(maxZoom, Math.log2(Math.min(width, height))) };
}
