import { ellipsoidDistance, meridianRadius } from "./geo.ts";
import type { GeoPoint } from "./geo.ts";
import { effectiveRadiusMeters } from "./privacy.ts";
import type { MaskZone } from "./privacy.ts";

/** `PRV-014`: five activities starting or finishing less than 150 m from one point earn a 300 m zone proposal. */
export const zoneProposalRules = { minActivities: 5, nearMeters: 150, radiusMeters: 300 } as const;

/** First and last positions of an activity's raw track, in degrees. */
export interface ActivityEnds {
  readonly start: GeoPoint;
  readonly end: GeoPoint;
}

export interface ZoneProposal {
  /** Mean of the starts and finishes near the recurring place. */
  readonly center: GeoPoint;
  readonly radiusMeters: number;
  /** Activities starting or finishing there. */
  readonly activities: number;
}

interface End {
  readonly activity: number;
  readonly point: GeoPoint;
}

interface Place {
  readonly center: GeoPoint;
  readonly activities: number;
}

function distance(from: GeoPoint, to: GeoPoint): number {
  return ellipsoidDistance(from.latitude, from.longitude, to.latitude, to.longitude);
}

function insideZone(point: GeoPoint, zones: readonly MaskZone[]): boolean {
  return zones.some((zone) => distance({ latitude: zone.latitudeE7 / 1e7, longitude: zone.longitudeE7 / 1e7 }, point) < effectiveRadiusMeters(zone));
}

function mean(ends: readonly End[]): GeoPoint {
  let latitude = 0;
  let longitude = 0;
  for (const end of ends) {
    latitude += end.point.latitude;
    longitude += end.point.longitude;
  }
  return { latitude: latitude / ends.length, longitude: longitude / ends.length };
}

/** The starts and finishes less than `nearMeters` from `probe`, scanning only the latitude band that can hold them. */
function endsNear(sorted: readonly End[], probe: End): End[] {
  const { nearMeters } = zoneProposalRules;
  const band = (nearMeters / (meridianRadius(probe.point.latitude) * Math.PI)) * 180 * 1.01;
  const near: End[] = [];
  for (const end of sorted) {
    if (end.point.latitude < probe.point.latitude - band) continue;
    if (end.point.latitude > probe.point.latitude + band) break;
    if (distance(probe.point, end.point) < nearMeters) near.push(end);
  }
  return near;
}

/**
 * The recurring start or finish place to offer as a zone (`PRV-014`), computed on the phone: the place most activities
 * start or finish near, if at least five do, outside every existing zone and away from the places already declined, since
 * each place is proposed only once. Null when there is nothing to propose.
 */
export function proposeZone(activities: readonly ActivityEnds[], zones: readonly MaskZone[], declined: readonly GeoPoint[]): ZoneProposal | null {
  const { minActivities, nearMeters, radiusMeters } = zoneProposalRules;
  const ends = activities
    .flatMap((activity, index): End[] => [
      { activity: index, point: activity.start },
      { activity: index, point: activity.end },
    ])
    .filter((end) => !insideZone(end.point, zones))
    .sort((left, right) => left.point.latitude - right.point.latitude);
  let best: Place | null = null;
  for (const probe of ends) {
    const near = endsNear(ends, probe);
    const count = new Set(near.map((end) => end.activity)).size;
    if (count < minActivities || (best !== null && count <= best.activities)) continue;
    const center = mean(near);
    if (declined.some((place) => distance(place, center) < nearMeters)) continue;
    best = { center, activities: count };
  }
  return best === null ? null : { center: best.center, radiusMeters, activities: best.activities };
}
