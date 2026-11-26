import type { LayerSpecification } from "@maplibre/maplibre-gl-style-spec";
import { displace, effectiveRadiusMeters } from "@obnixe/core";
import type { GeoPoint, MaskZone } from "@obnixe/core";
import type { LngLat } from "@/features/maps/surface";
import { bufferedBounds } from "@/features/maps/tiles";
import type { Bounds } from "@/features/maps/tiles";
import { metersPerPixel } from "@/features/maps/viewport";

export const privacyZonesSourceId = "obnixe-privacy-zones";

/** Below this radius on screen the center cannot be placed precisely: the editor asks to zoom in. */
export const minPlacementPixels = 24;

const ringVertices = 72;

export function zoneCenter(zone: MaskZone): GeoPoint {
  return { latitude: zone.latitudeE7 / 1e7, longitude: zone.longitudeE7 / 1e7 };
}

/** Closed ring of points `radiusMeters` from the center, as GeoJSON positions. */
export function circleRing(center: GeoPoint, radiusMeters: number): LngLat[] {
  const ring: LngLat[] = [];
  for (let index = 0; index <= ringVertices; index += 1) {
    const angle = (2 * Math.PI * (index % ringVertices)) / ringVertices;
    const point = displace(center.latitude, center.longitude, radiusMeters * Math.sin(angle), radiusMeters * Math.cos(angle));
    ring.push([point.longitude, point.latitude]);
  }
  return ring;
}

/**
 * Each zone as two circles: `masked`, out to the effective radius within which no point ever leaves the phone (`PRV-012`),
 * and `radius`, the radius the user chose. GeoJSON text for a map overlay.
 */
export function zonesGeoJson(zones: readonly MaskZone[]): string {
  const features = zones.flatMap((zone) => {
    const center = zoneCenter(zone);
    return [
      { type: "Feature", properties: { kind: "masked" }, geometry: { type: "Polygon", coordinates: [circleRing(center, effectiveRadiusMeters(zone))] } },
      { type: "Feature", properties: { kind: "radius" }, geometry: { type: "Polygon", coordinates: [circleRing(center, zone.radiusMeters)] } },
    ];
  });
  return JSON.stringify({ type: "FeatureCollection", features });
}

/** Extent of every masked area, null without zones. */
export function zonesBounds(zones: readonly MaskZone[]): Bounds | null {
  let merged: Bounds | null = null;
  for (const zone of zones) {
    const bounds = bufferedBounds([zoneCenter(zone)], effectiveRadiusMeters(zone));
    if (bounds === null) continue;
    merged = merged === null ? bounds : [Math.min(merged[0], bounds[0]), Math.min(merged[1], bounds[1]), Math.max(merged[2], bounds[2]), Math.max(merged[3], bounds[3])];
  }
  return merged;
}

/** On-screen radius of a circle drawn at the center of the view. */
export function radiusPixels(radiusMeters: number, latitude: number, zoom: number): number {
  return radiusMeters / metersPerPixel(latitude, zoom);
}

/** Tinted masked area with a dashed edge, and the chosen radius as a solid line. */
export function privacyZoneLayers(color: string): LayerSpecification[] {
  return [
    {
      id: "obnixe-privacy-masked",
      type: "fill",
      source: privacyZonesSourceId,
      filter: ["==", ["get", "kind"], "masked"],
      paint: { "fill-color": color, "fill-opacity": 0.16 },
    },
    {
      id: "obnixe-privacy-masked-edge",
      type: "line",
      source: privacyZonesSourceId,
      filter: ["==", ["get", "kind"], "masked"],
      paint: { "line-color": color, "line-width": 1.5, "line-dasharray": [2, 1.5] },
    },
    {
      id: "obnixe-privacy-radius",
      type: "line",
      source: privacyZonesSourceId,
      filter: ["==", ["get", "kind"], "radius"],
      paint: { "line-color": color, "line-width": 2.5 },
    },
  ];
}
