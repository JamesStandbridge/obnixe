import type { ExpressionSpecification, LayerSpecification } from "@maplibre/maplibre-gl-style-spec";
import type { LngLat } from "@/features/maps/surface";
import { headingImage, rims } from "@/features/maps/trackLayers";
import type { PaletteName } from "@/ui/tokens";

export const routeSourceId = "obnixe-route";
export const rejoinSourceId = "obnixe-route-rejoin";

/** Wider than the track, so the travelled track drawn over it stays visible (`RTE-003`). */
const routeWidth: ExpressionSpecification = ["interpolate", ["exponential", 1.5], ["zoom"], 8, 4, 13, 8, 17, 14];
const routeRimWidth: ExpressionSpecification = ["interpolate", ["exponential", 1.5], ["zoom"], 8, 6, 13, 11, 17, 18];

export function routeLineData(coordinates: readonly LngLat[]): string {
  return JSON.stringify({ type: "FeatureCollection", features: [{ type: "Feature", properties: { kind: "route" }, geometry: { type: "LineString", coordinates } }] });
}

/** The followed route: a wide line in its own color under the track, with arrows in the direction to follow. */
export function routeLayers(color: string, variant: PaletteName): LayerSpecification[] {
  const rim = rims[variant];
  return [
    {
      id: "obnixe-route-rim",
      type: "line",
      source: routeSourceId,
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": rim, "line-width": routeRimWidth, "line-opacity": 0.6 },
    },
    {
      id: "obnixe-route",
      type: "line",
      source: routeSourceId,
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": color, "line-width": routeWidth, "line-opacity": 0.55 },
    },
    {
      id: "obnixe-route-arrows",
      type: "symbol",
      source: routeSourceId,
      layout: {
        "symbol-placement": "line",
        "symbol-spacing": 90,
        "icon-image": headingImage,
        "icon-size": 0.7,
        "icon-rotate": 90,
        "icon-rotation-alignment": "map",
        "icon-allow-overlap": true,
        "icon-ignore-placement": true,
      },
      paint: { "icon-color": rim, "icon-opacity": 0.85 },
    },
  ];
}

/** `RTE-005`: off the route, a dashed line from the position to the nearest route point downstream. */
export function rejoinData(from: LngLat, to: LngLat): string {
  return JSON.stringify({ type: "FeatureCollection", features: [{ type: "Feature", properties: { kind: "rejoin" }, geometry: { type: "LineString", coordinates: [from, to] } }] });
}

export function rejoinLayers(color: string, variant: PaletteName): LayerSpecification[] {
  return [
    {
      id: "obnixe-route-rejoin-rim",
      type: "line",
      source: rejoinSourceId,
      layout: { "line-cap": "round" },
      paint: { "line-color": rims[variant], "line-width": 5, "line-opacity": 0.8 },
    },
    {
      id: "obnixe-route-rejoin",
      type: "line",
      source: rejoinSourceId,
      layout: { "line-cap": "butt" },
      paint: { "line-color": color, "line-width": 3, "line-dasharray": [1.5, 1.5] },
    },
  ];
}
