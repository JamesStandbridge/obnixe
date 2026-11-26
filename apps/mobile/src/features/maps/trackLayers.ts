import type { ExpressionSpecification, LayerSpecification } from "@maplibre/maplibre-gl-style-spec";
import type { PaletteName } from "@/ui/tokens";

export interface TrackColors {
  /** Color at the start of the track. */
  readonly from: string;
  /** Color at the head of the track. */
  readonly to: string;
}

export const trackSourceId = "obnixe-track";
export const pointsSourceId = "obnixe-points";
export const headingImage = "obnixe-heading";

/** Rim in the map's ground tone (near black on dark, white in sunlight) so the track reads over any ground (MAP-008). */
const rims: Readonly<Record<PaletteName, string>> = { dark: "#0b0e11", sunlight: "#ffffff" };

const trackWidth: ExpressionSpecification = ["interpolate", ["exponential", 1.5], ["zoom"], 8, 2.5, 13, 4.5, 17, 8];
const rimWidth: ExpressionSpecification = ["interpolate", ["exponential", 1.5], ["zoom"], 8, 4.5, 13, 7.5, 17, 12];

/** Gradient track, casing and dashed interruptions, for a GeoJSON source with `lineMetrics`. */
export function trackLayers(colors: TrackColors, variant: PaletteName): LayerSpecification[] {
  const rim = rims[variant];
  return [
    {
      id: "obnixe-track-rim",
      type: "line",
      source: trackSourceId,
      filter: ["==", ["get", "kind"], "track"],
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": rim, "line-width": rimWidth, "line-opacity": 0.9 },
    },
    {
      id: "obnixe-track",
      type: "line",
      source: trackSourceId,
      filter: ["==", ["get", "kind"], "track"],
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-width": trackWidth, "line-gradient": ["interpolate", ["linear"], ["line-progress"], 0, colors.from, 1, colors.to] },
    },
    {
      id: "obnixe-track-interrupted",
      type: "line",
      source: trackSourceId,
      filter: ["==", ["get", "kind"], "interrupted"],
      layout: { "line-cap": "butt", "line-join": "round" },
      paint: { "line-color": rim, "line-width": trackWidth, "line-dasharray": [1, 1.2] },
    },
  ];
}

/** Start mark, accuracy circle, position dot and course arrow. */
export function pointLayers(colors: TrackColors, variant: PaletteName): LayerSpecification[] {
  const rim = rims[variant];
  const isPosition: ExpressionSpecification = ["==", ["get", "kind"], "position"];
  return [
    {
      id: "obnixe-start",
      type: "circle",
      source: pointsSourceId,
      filter: ["==", ["get", "kind"], "start"],
      paint: { "circle-radius": 5.5, "circle-color": rim, "circle-stroke-color": colors.from, "circle-stroke-width": 3 },
    },
    {
      id: "obnixe-accuracy",
      type: "circle",
      source: pointsSourceId,
      filter: isPosition,
      paint: {
        "circle-radius": ["interpolate", ["exponential", 2], ["zoom"], 0, ["get", "accuracy0"], 24, ["*", ["get", "accuracy0"], 16_777_216]],
        "circle-color": colors.to,
        "circle-opacity": 0.14,
        "circle-stroke-color": colors.to,
        "circle-stroke-width": 1,
        "circle-stroke-opacity": 0.4,
        "circle-pitch-alignment": "map",
      },
    },
    {
      id: "obnixe-heading",
      type: "symbol",
      source: pointsSourceId,
      filter: ["all", isPosition, ["has", "bearing"]],
      layout: {
        "icon-image": headingImage,
        "icon-size": 1,
        "icon-rotate": ["get", "bearing"],
        "icon-rotation-alignment": "map",
        "icon-offset": [0, -11],
        "icon-allow-overlap": true,
        "icon-ignore-placement": true,
      },
      paint: { "icon-color": colors.to, "icon-halo-color": rim, "icon-halo-width": 1.5 },
    },
    {
      id: "obnixe-position",
      type: "circle",
      source: pointsSourceId,
      filter: isPosition,
      paint: { "circle-radius": 7, "circle-color": colors.to, "circle-stroke-color": rim, "circle-stroke-width": 3, "circle-pitch-alignment": "map" },
    },
  ];
}
