import type { PrivacyZone } from "@obnixe/schema";
import { ellipsoidDistance, meridianRadius } from "./geo.ts";

/** Bounds of the per-zone draw of `PRV-012`, stored in `privacy_zone.mask_scale_permille`. */
export const maskScaleBounds = { minPermille: 1000, maxPermille: 1300 } as const;

/** Positions in degrees, one per point, in track order. */
export interface TrackPositions {
  readonly length: number;
  readonly latitude: Float64Array;
  readonly longitude: Float64Array;
}

export type MaskZone = Pick<PrivacyZone, "latitudeE7" | "longitudeE7" | "radiusMeters" | "maskScalePermille">;

export interface MaskOptions {
  /** `settings.hide_track_ends_meters`: along-track length hidden at each end of the track. */
  readonly hideEndsMeters: number;
}

/** Half-open range of point indices. */
export interface PointRange {
  readonly start: number;
  readonly end: number;
}

export interface MaskedTrack {
  /** 1 for every point that must not leave the detail screen. */
  readonly hidden: Uint8Array;
  /** Maximal runs of visible points, each drawn as its own line so no segment crosses a hidden part. */
  readonly visible: readonly PointRange[];
}

/** The draw kept with a new zone: the masked distance is between 1 and 1.3 times its radius (`PRV-012`). */
export function drawMaskScalePermille(uniform: () => number): number {
  const span = maskScaleBounds.maxPermille - maskScaleBounds.minPermille + 1;
  return maskScaleBounds.minPermille + Math.min(Math.floor(uniform() * span), span - 1);
}

/** Distance from the center within which no point is ever shown, and the along-track distance masked around each visit. */
export function effectiveRadiusMeters(zone: MaskZone): number {
  return (zone.radiusMeters * zone.maskScalePermille) / 1000;
}

function alongTrack(track: TrackPositions): Float64Array {
  const distance = new Float64Array(track.length);
  for (let index = 1; index < track.length; index += 1) {
    const step = ellipsoidDistance(track.latitude[index - 1] ?? 0, track.longitude[index - 1] ?? 0, track.latitude[index] ?? 0, track.longitude[index] ?? 0);
    distance[index] = (distance[index - 1] ?? 0) + step;
  }
  return distance;
}

function hideTrackEnds(distance: Float64Array, meters: number, hidden: Uint8Array): void {
  if (meters <= 0) return;
  const total = distance[distance.length - 1] ?? 0;
  for (let index = 0; index < distance.length; index += 1) {
    const at = distance[index] ?? 0;
    if (at <= meters || total - at <= meters) hidden[index] = 1;
  }
}

/** Hides the points around one visit: those `radius` or less along the track from its point closest to the center. */
function hideAlongTrack(distance: Float64Array, anchor: number, radius: number, hidden: Uint8Array): void {
  const center = distance[anchor] ?? 0;
  for (let index = anchor; index >= 0 && center - (distance[index] ?? 0) <= radius; index -= 1) hidden[index] = 1;
  for (let index = anchor + 1; index < distance.length && (distance[index] ?? 0) - center <= radius; index += 1) hidden[index] = 1;
}

function hideZone(track: TrackPositions, distance: Float64Array, zone: MaskZone, hidden: Uint8Array): void {
  const latitude = zone.latitudeE7 / 1e7;
  const longitude = zone.longitudeE7 / 1e7;
  const radius = effectiveRadiusMeters(zone);
  const latitudeReach = ((1.01 * radius) / (meridianRadius(latitude) * Math.PI)) * 180;
  let anchor = -1;
  let closest = Number.POSITIVE_INFINITY;
  for (let index = 0; index <= track.length; index += 1) {
    let inside = false;
    if (index < track.length) {
      const pointLatitude = track.latitude[index] ?? 0;
      if (Math.abs(pointLatitude - latitude) < latitudeReach) {
        const gap = ellipsoidDistance(latitude, longitude, pointLatitude, track.longitude[index] ?? 0);
        if (gap < radius) {
          inside = true;
          hidden[index] = 1;
          if (gap < closest) {
            closest = gap;
            anchor = index;
          }
        }
      }
    }
    if (inside || anchor < 0) continue;
    hideAlongTrack(distance, anchor, radius, hidden);
    anchor = -1;
    closest = Number.POSITIVE_INFINITY;
  }
}

function visibleRanges(hidden: Uint8Array): PointRange[] {
  const ranges: PointRange[] = [];
  let start = -1;
  for (let index = 0; index <= hidden.length; index += 1) {
    const visible = index < hidden.length && hidden[index] === 0;
    if (visible && start < 0) start = index;
    if (!visible && start >= 0) {
      ranges.push({ start, end: index });
      start = -1;
    }
  }
  return ranges;
}

/**
 * Points to remove from everything that leaves the detail screen (`PRV-010`): every point closer to a zone center than its
 * effective radius, every point within that distance along the track of each visit's closest point (`PRV-012`, so the
 * visible ends of a crossing do not outline the circle), and the first and last `hideEndsMeters`. The track itself is
 * left untouched, as are the metrics computed from it (`PRV-013`).
 */
export function maskTrack(track: TrackPositions, zones: readonly MaskZone[], options: MaskOptions): MaskedTrack {
  const hidden = new Uint8Array(track.length);
  if (track.length === 0) return { hidden, visible: [] };
  const distance = alongTrack(track);
  hideTrackEnds(distance, options.hideEndsMeters, hidden);
  for (const zone of zones) hideZone(track, distance, zone, hidden);
  return { hidden, visible: visibleRanges(hidden) };
}
