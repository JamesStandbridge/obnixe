import { simplifyPath } from "@obnixe/core";
import type { TrackSeries } from "@obnixe/core";
import type { BoundingBoxE7 } from "@obnixe/schema";
import type { Bounds } from "@/features/maps/tiles";

export interface SummaryTrack {
  /** GeoJSON text for `trackLayers`: one `track` line. */
  readonly track: string;
  /** GeoJSON text for `pointLayers`: the `start` and the finish drawn as the last `position`. */
  readonly points: string;
}

const toleranceMeters = 3;
const maxPoints = 1500;

function coordinate(latitude: number, longitude: number): string {
  return `[${longitude.toFixed(6)},${latitude.toFixed(6)}]`;
}

/** `REC-050`: the stop summary map, simplified for display (`GPS-070`); null without two positions. */
export function summaryTrack(series: Pick<TrackSeries, "length" | "latitude" | "longitude">): SummaryTrack | null {
  if (series.length < 2) return null;
  const kept = simplifyPath(series.latitude, series.longitude, toleranceMeters, maxPoints);
  const line = Array.from(kept, (index) => coordinate(series.latitude[index] ?? 0, series.longitude[index] ?? 0)).join(",");
  const first = coordinate(series.latitude[0] ?? 0, series.longitude[0] ?? 0);
  const last = coordinate(series.latitude[series.length - 1] ?? 0, series.longitude[series.length - 1] ?? 0);
  return {
    track: `{"type":"FeatureCollection","features":[{"type":"Feature","properties":{"kind":"track"},"geometry":{"type":"LineString","coordinates":[${line}]}}]}`,
    points: `{"type":"FeatureCollection","features":[{"type":"Feature","properties":{"kind":"start"},"geometry":{"type":"Point","coordinates":${first}}},{"type":"Feature","properties":{"kind":"position","accuracy0":0},"geometry":{"type":"Point","coordinates":${last}}}]}`,
  };
}

export function boundsOf(box: BoundingBoxE7): Bounds {
  return [box.west / 1e7, box.south / 1e7, box.east / 1e7, box.north / 1e7];
}
