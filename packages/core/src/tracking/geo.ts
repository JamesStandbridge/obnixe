import type { BoundingBoxE7 } from "@obnixe/schema";

/** WGS 84 semi-major axis in meters. */
export const wgs84SemiMajorAxis = 6_378_137;
/** WGS 84 first eccentricity squared. */
export const wgs84EccentricitySquared = 6.69437999014e-3;

const radiansPerDegree = Math.PI / 180;

export interface GeoPoint {
  readonly latitude: number;
  readonly longitude: number;
}

/** Offset in meters in the plane tangent to the ellipsoid at a reference point. */
export interface EastNorth {
  readonly east: number;
  readonly north: number;
}

/** Radius of curvature in the meridian, M(phi), in meters. */
export function meridianRadius(latitude: number): number {
  const sine = Math.sin(latitude * radiansPerDegree);
  const w = 1 - wgs84EccentricitySquared * sine * sine;
  return (wgs84SemiMajorAxis * (1 - wgs84EccentricitySquared)) / (w * Math.sqrt(w));
}

/** Radius of the parallel, N(phi) cos(phi), in meters. */
export function parallelRadius(latitude: number): number {
  const angle = latitude * radiansPerDegree;
  const sine = Math.sin(angle);
  return (wgs84SemiMajorAxis * Math.cos(angle)) / Math.sqrt(1 - wgs84EccentricitySquared * sine * sine);
}

function longitudeDelta(from: number, to: number): number {
  const delta = to - from;
  if (delta > 180) return delta - 360;
  if (delta < -180) return delta + 360;
  return delta;
}

/** Offset of `(latitude, longitude)` from the reference point, with the WGS 84 radii at the mean latitude (`GPS-036`). */
export function eastNorthBetween(fromLatitude: number, fromLongitude: number, latitude: number, longitude: number): EastNorth {
  const mean = (fromLatitude + latitude) / 2;
  return {
    east: parallelRadius(mean) * longitudeDelta(fromLongitude, longitude) * radiansPerDegree,
    north: meridianRadius(mean) * (latitude - fromLatitude) * radiansPerDegree,
  };
}

/** Horizontal ellipsoidal distance in meters (`GPS-036`), relative error below 1e-6 for segments under 1 km. */
export function ellipsoidDistance(fromLatitude: number, fromLongitude: number, latitude: number, longitude: number): number {
  const offset = eastNorthBetween(fromLatitude, fromLongitude, latitude, longitude);
  return Math.hypot(offset.east, offset.north);
}

/**
 * Point reached by moving `east` and `north` meters from the reference point: the inverse of `eastNorthBetween`.
 * Re-anchoring the tangent plane on every estimate makes a sliding local frame with no accumulated distortion.
 */
export function displace(latitude: number, longitude: number, east: number, north: number): GeoPoint {
  const midLatitude = latitude + north / (2 * meridianRadius(latitude) * radiansPerDegree);
  const nextLatitude = latitude + north / (meridianRadius(midLatitude) * radiansPerDegree);
  const nextLongitude = longitude + east / (parallelRadius((latitude + nextLatitude) / 2) * radiansPerDegree);
  return { latitude: nextLatitude, longitude: nextLongitude > 180 ? nextLongitude - 360 : nextLongitude < -180 ? nextLongitude + 360 : nextLongitude };
}

/** The box grown by `meters` on every side, clamped to the valid coordinates. */
export function expandBoundingBox(box: BoundingBoxE7, meters: number): BoundingBoxE7 {
  const extreme = Math.max(Math.abs(box.south), Math.abs(box.north)) / 1e7;
  const latitudeMargin = (meters / (meridianRadius(extreme) * radiansPerDegree)) * 1e7;
  const longitudeMargin = (meters / (Math.max(parallelRadius(Math.min(extreme, 89)), 1) * radiansPerDegree)) * 1e7;
  return {
    south: Math.max(-900_000_000, Math.floor(box.south - latitudeMargin)),
    west: Math.max(-1_800_000_000, Math.floor(box.west - longitudeMargin)),
    north: Math.min(900_000_000, Math.ceil(box.north + latitudeMargin)),
    east: Math.min(1_800_000_000, Math.ceil(box.east + longitudeMargin)),
  };
}

export function boxesOverlap(left: BoundingBoxE7, right: BoundingBoxE7): boolean {
  return left.south <= right.north && right.south <= left.north && left.west <= right.east && right.west <= left.east;
}

/** Accumulates the extent of a track; tracks crossing the antimeridian get the full longitude span. */
export class BoundingBoxBuilder {
  private south = Number.POSITIVE_INFINITY;
  private west = Number.POSITIVE_INFINITY;
  private north = Number.NEGATIVE_INFINITY;
  private east = Number.NEGATIVE_INFINITY;

  include(latitude: number, longitude: number): void {
    if (latitude < this.south) this.south = latitude;
    if (latitude > this.north) this.north = latitude;
    if (longitude < this.west) this.west = longitude;
    if (longitude > this.east) this.east = longitude;
  }

  build(): BoundingBoxE7 | null {
    if (this.south > this.north) return null;
    return {
      south: Math.floor(this.south * 1e7),
      west: Math.floor(this.west * 1e7),
      north: Math.ceil(this.north * 1e7),
      east: Math.ceil(this.east * 1e7),
    };
  }
}
