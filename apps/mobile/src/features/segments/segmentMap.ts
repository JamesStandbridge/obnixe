import type { LayerSpecification } from "@maplibre/maplibre-gl-style-spec";
import { maskTrack, segmentShape } from "@obnixe/core";
import type { MaskZone } from "@obnixe/core";
import type { Segment } from "@obnixe/schema";
import { rimWidth, trackWidth } from "@/features/maps/trackLayers";
import type { Bounds } from "@/features/maps/tiles";

export const segmentSourceId = "obnixe-segment";

export interface SegmentMapGeometry {
  /** GeoJSON text of the visible runs and of the visible ends. */
  readonly data: string;
  readonly bounds: Bounds | null;
  readonly masked: boolean;
}

type Feature = { readonly type: "Feature"; readonly properties: { readonly kind: "line" | "start" | "finish" }; readonly geometry: { readonly type: "LineString" | "Point"; readonly coordinates: unknown } };

/**
 * The segment as the screens outside the activity detail draw it (`PRV-010`): no point within a privacy zone. The polyline is
 * masked at its 10 m coverage points, so a long straight edge never draws a chord across a zone.
 */
export function segmentMapGeometry(row: Pick<Segment, "id" | "family" | "polyline" | "distanceMm" | "bbox">, zones: readonly MaskZone[]): SegmentMapGeometry {
  const points = segmentShape(row).probes;
  const masked = maskTrack(points, zones, { hideEndsMeters: 0 });
  const features: Feature[] = [];
  const at = (index: number): readonly [number, number] => [points.longitude[index] ?? 0, points.latitude[index] ?? 0];
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  for (const { start, end } of masked.visible) {
    const coordinates: (readonly [number, number])[] = [];
    for (let index = start; index < end; index += 1) {
      const point = at(index);
      coordinates.push(point);
      west = Math.min(west, point[0]);
      east = Math.max(east, point[0]);
      south = Math.min(south, point[1]);
      north = Math.max(north, point[1]);
    }
    if (coordinates.length >= 2) features.push({ type: "Feature", properties: { kind: "line" }, geometry: { type: "LineString", coordinates } });
  }
  const last = points.length - 1;
  if (last > 0 && masked.hidden[0] === 0) features.push({ type: "Feature", properties: { kind: "start" }, geometry: { type: "Point", coordinates: at(0) } });
  if (last > 0 && masked.hidden[last] === 0) features.push({ type: "Feature", properties: { kind: "finish" }, geometry: { type: "Point", coordinates: at(last) } });
  return {
    data: JSON.stringify({ type: "FeatureCollection", features }),
    bounds: west === Infinity ? null : [west, south, east, north],
    masked: masked.hidden.includes(1),
  };
}

export interface SegmentLayerColors {
  readonly line: string;
  readonly rim: string;
  readonly start: string;
  readonly finish: string;
}

export function segmentLayers(colors: SegmentLayerColors): LayerSpecification[] {
  return [
    {
      id: "obnixe-segment-rim",
      type: "line",
      source: segmentSourceId,
      filter: ["==", ["get", "kind"], "line"],
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": colors.rim, "line-width": rimWidth, "line-opacity": 0.9 },
    },
    {
      id: "obnixe-segment-line",
      type: "line",
      source: segmentSourceId,
      filter: ["==", ["get", "kind"], "line"],
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": colors.line, "line-width": trackWidth },
    },
    {
      id: "obnixe-segment-finish",
      type: "circle",
      source: segmentSourceId,
      filter: ["==", ["get", "kind"], "finish"],
      paint: { "circle-radius": 6, "circle-color": colors.finish, "circle-stroke-color": colors.rim, "circle-stroke-width": 3 },
    },
    {
      id: "obnixe-segment-start",
      type: "circle",
      source: segmentSourceId,
      filter: ["==", ["get", "kind"], "start"],
      paint: { "circle-radius": 6, "circle-color": colors.rim, "circle-stroke-color": colors.start, "circle-stroke-width": 3.5 },
    },
  ];
}
