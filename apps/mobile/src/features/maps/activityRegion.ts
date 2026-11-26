import { measuredRecordingOf, NotMeasuredError } from "@obnixe/core";
import type { ObnixeDatabase } from "@obnixe/core";
import type { Id } from "@obnixe/schema";
import type { LayerSpecification } from "@maplibre/maplibre-gl-style-spec";
import { bufferedBounds } from "@/features/maps/tiles";
import type { Bounds, GeoPoint } from "@/features/maps/tiles";
import { sessionTitle } from "@/format/labels";

/** Margins around the track, in kilometers. */
export const activityRegionMargins = ["1", "2", "5", "10"] as const;
export type ActivityRegionMargin = (typeof activityRegionMargins)[number];

export interface ActivityArea {
  readonly title: string;
  readonly corners: readonly GeoPoint[];
}

/** The extent of a recorded activity, for an offline region around it (MAP-031). */
export function activityArea(database: ObnixeDatabase, sessionId: Id): ActivityArea | null {
  try {
    const { session, recording } = measuredRecordingOf(database, sessionId);
    if (recording.bbox === null) return null;
    const { south, west, north, east } = recording.bbox;
    return {
      title: sessionTitle({ ...session, slotName: null, variantName: null, recorded: true }),
      corners: [
        { latitude: south / 1e7, longitude: west / 1e7 },
        { latitude: north / 1e7, longitude: east / 1e7 },
      ],
    };
  } catch (error) {
    if (error instanceof NotMeasuredError) return null;
    throw error;
  }
}

export function activityRegionBounds(area: ActivityArea, margin: ActivityRegionMargin): Bounds | null {
  return bufferedBounds(area.corners, Number(margin) * 1000);
}

export const regionOutlineSourceId = "obnixe-offline-region";

export function regionOutline([west, south, east, north]: Bounds): string {
  const ring = [
    [west, south],
    [east, south],
    [east, north],
    [west, north],
    [west, south],
  ];
  return JSON.stringify({ type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [ring] } });
}

export function regionOutlineLayers(color: string): LayerSpecification[] {
  return [
    { id: `${regionOutlineSourceId}-fill`, type: "fill", source: regionOutlineSourceId, paint: { "fill-color": color, "fill-opacity": 0.08 } },
    { id: `${regionOutlineSourceId}-line`, type: "line", source: regionOutlineSourceId, paint: { "line-color": color, "line-width": 2 } },
  ];
}
