import type { ExpressionSpecification, LayerSpecification } from "@maplibre/maplibre-gl-style-spec";
import { rims, rimWidth, trackWidth } from "@/features/maps/trackLayers";
import type { Ramp, TrackPalette } from "@/features/recordings/palette";
import { unknownValue } from "@/features/recordings/trackMap";
import type { TrackColoring } from "@/features/recordings/trackMap";
import type { PaletteName } from "@/ui/tokens";

export const activityTrackSourceId = "obnixe-activity-track";
export const activityMarksSourceId = "obnixe-activity-marks";
export const activityCursorSourceId = "obnixe-activity-cursor";

export interface ActivityLayerColors {
  readonly from: string;
  readonly to: string;
  readonly mark: string;
  readonly text: string;
  readonly palette: TrackPalette;
}

function rampExpression(ramp: Ramp): ExpressionSpecification {
  const stops = ramp.flatMap((color, index) => [ramp.length === 1 ? 0 : index / (ramp.length - 1), color]);
  return ["interpolate", ["linear"], ["get", "v"], ...stops] as ExpressionSpecification;
}

/** The ramp a coloring paints with: from the deep to the bright sport tone along the activity, or a metric scale. */
export function coloringRamp(coloring: Exclude<TrackColoring, "heart_rate">, colors: ActivityLayerColors): Ramp {
  switch (coloring) {
    case "progress":
      return [colors.from, colors.to];
    case "pace":
    case "speed":
      return colors.palette.effort;
    case "grade":
      return colors.palette.grade;
    case "altitude":
      return colors.palette.altitude;
    default: {
      const unhandled: never = coloring;
      throw new Error(`Unhandled coloring ${String(unhandled)}`);
    }
  }
}

function lineColor(coloring: TrackColoring, colors: ActivityLayerColors): ExpressionSpecification {
  const { palette } = colors;
  const known: ExpressionSpecification =
    coloring === "heart_rate"
      ? (["match", ["get", "v"], 1, palette.zones[0] ?? palette.unknown, 2, palette.zones[1] ?? palette.unknown, 3, palette.zones[2] ?? palette.unknown, 4, palette.zones[3] ?? palette.unknown, 5, palette.zones[4] ?? palette.unknown, palette.unknown] as ExpressionSpecification)
      : rampExpression(coloringRamp(coloring, colors));
  return ["case", ["==", ["get", "v"], unknownValue], palette.unknown, known] as ExpressionSpecification;
}

/** The detail map (`MAP-020`, `MAP-021`): colored track over its rim, dashed interruptions, stones, laps, ends and cursor. */
export function activityLayers(colors: ActivityLayerColors, variant: PaletteName, coloring: TrackColoring, labels: boolean): LayerSpecification[] {
  const rim = rims[variant];
  const kind = (value: string): ExpressionSpecification => ["==", ["get", "kind"], value];
  const label: LayerSpecification[] = labels
    ? [
        {
          id: "obnixe-activity-km-label",
          type: "symbol",
          source: activityMarksSourceId,
          filter: kind("km"),
          minzoom: 11,
          layout: { "text-field": ["get", "label"], "text-font": ["SofiaSansCondensed-SemiBold"], "text-size": 10, "text-allow-overlap": false },
          paint: { "text-color": colors.text },
        },
        {
          id: "obnixe-activity-lap-label",
          type: "symbol",
          source: activityMarksSourceId,
          filter: kind("lap"),
          layout: { "text-field": ["get", "label"], "text-font": ["SofiaSansCondensed-SemiBold"], "text-size": 10, "text-allow-overlap": true },
          paint: { "text-color": rim },
        },
      ]
    : [];
  return [
    {
      id: "obnixe-activity-rim",
      type: "line",
      source: activityTrackSourceId,
      filter: kind("track"),
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": rim, "line-width": rimWidth, "line-opacity": 0.9 },
    },
    {
      id: "obnixe-activity-interrupted",
      type: "line",
      source: activityTrackSourceId,
      filter: kind("interrupted"),
      layout: { "line-cap": "butt", "line-join": "round" },
      paint: { "line-color": colors.palette.unknown, "line-width": trackWidth, "line-dasharray": [1, 1.2] },
    },
    {
      id: "obnixe-activity-track",
      type: "line",
      source: activityTrackSourceId,
      filter: kind("track"),
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": lineColor(coloring, colors), "line-width": trackWidth },
    },
    {
      id: "obnixe-activity-km",
      type: "circle",
      source: activityMarksSourceId,
      filter: kind("km"),
      minzoom: labels ? 0 : 10,
      paint: {
        "circle-radius": labels ? ["step", ["zoom"], 3, 11, 8] : 3,
        "circle-color": rim,
        "circle-stroke-color": colors.text,
        "circle-stroke-width": 1.5,
      },
    },
    {
      id: "obnixe-activity-lap",
      type: "circle",
      source: activityMarksSourceId,
      filter: kind("lap"),
      paint: { "circle-radius": labels ? 8 : 5, "circle-color": colors.mark, "circle-stroke-color": rim, "circle-stroke-width": 2 },
    },
    ...label,
    {
      id: "obnixe-activity-finish",
      type: "circle",
      source: activityMarksSourceId,
      filter: kind("finish"),
      paint: { "circle-radius": 6, "circle-color": colors.text, "circle-stroke-color": rim, "circle-stroke-width": 3 },
    },
    {
      id: "obnixe-activity-start",
      type: "circle",
      source: activityMarksSourceId,
      filter: kind("start"),
      paint: { "circle-radius": 6, "circle-color": rim, "circle-stroke-color": colors.from, "circle-stroke-width": 3.5 },
    },
    {
      id: "obnixe-activity-cursor",
      type: "circle",
      source: activityCursorSourceId,
      paint: { "circle-radius": 8, "circle-color": colors.mark, "circle-stroke-color": rim, "circle-stroke-width": 3 },
    },
  ];
}
