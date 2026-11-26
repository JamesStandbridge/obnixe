import type { ExpressionSpecification, LayerSpecification } from "@maplibre/maplibre-gl-style-spec";
import type { PaletteName } from "@/ui/tokens";

/** Which network the style puts forward: trails for sports on foot, cycleways for the bike (MAP-002). */
export type MapEmphasis = "foot" | "bike";

export interface OutdoorPalette {
  readonly land: string;
  readonly urban: string;
  readonly farmland: string;
  readonly grass: string;
  readonly wood: string;
  readonly wetland: string;
  readonly sand: string;
  readonly rock: string;
  readonly ice: string;
  readonly iceLine: string;
  readonly park: string;
  readonly water: string;
  readonly waterway: string;
  readonly building: string;
  readonly casing: string;
  readonly minor: string;
  readonly major: string;
  readonly highway: string;
  readonly highwayCasing: string;
  readonly rail: string;
  readonly track: string;
  readonly path: string;
  readonly cycleway: string;
  readonly aerialway: string;
  readonly boundary: string;
  readonly label: string;
  readonly labelMuted: string;
  readonly labelStrong: string;
  readonly labelWater: string;
  readonly halo: string;
  readonly summit: string;
  readonly poi: string;
  readonly drinkingWater: string;
  readonly parking: string;
  readonly parkingInk: string;
  readonly shadow: string;
  readonly highlight: string;
  readonly accent: string;
  readonly contour: string;
  /** Hillshade strength at z9, z12 and z16 (MAP-005). */
  readonly relief: readonly [number, number, number];
}

type OutdoorColor = Exclude<keyof OutdoorPalette, "relief">;

export const outdoorPalettes: Readonly<Record<PaletteName, OutdoorPalette>> = {
  dark: {
    land: "#13181d",
    urban: "#181e24",
    farmland: "#151b18",
    grass: "#162119",
    wood: "#132219",
    wetland: "#13201f",
    sand: "#211f1a",
    rock: "#1c1f22",
    ice: "#1a252c",
    iceLine: "#2d4250",
    park: "#1d3324",
    water: "#11304a",
    waterway: "#183650",
    building: "#1d2329",
    casing: "#0d1115",
    minor: "#323b45",
    major: "#4a5560",
    highway: "#8a7a52",
    highwayCasing: "#0d1115",
    rail: "#3a434c",
    track: "#9a8f7c",
    path: "#d3dae1",
    cycleway: "#4fc3d6",
    aerialway: "#7b858f",
    boundary: "#5b6670",
    label: "#b8c0c8",
    labelMuted: "#7f8992",
    labelStrong: "#eef2f5",
    labelWater: "#5f8fb0",
    halo: "#0b0e11",
    summit: "#d9c7a6",
    poi: "#aeb7c0",
    drinkingWater: "#5aa9d6",
    parking: "#3e6fd8",
    parkingInk: "#f2f5f7",
    shadow: "#000000",
    highlight: "rgba(206, 222, 234, 0.3)",
    accent: "rgba(3, 7, 10, 0.5)",
    contour: "#c4a77c",
    relief: [0.32, 0.46, 0.32],
  },
  sunlight: {
    land: "#f3f4ef",
    urban: "#e9eae4",
    farmland: "#eef0e2",
    grass: "#e1ebd4",
    wood: "#cfe1c4",
    wetland: "#d9e9e2",
    sand: "#f2e9d0",
    rock: "#e4e2dc",
    ice: "#eaf5f9",
    iceLine: "#a6cbdb",
    park: "#9fc490",
    water: "#a7d2e6",
    waterway: "#86bfda",
    building: "#e1e0d8",
    casing: "#d3d4cb",
    minor: "#ffffff",
    major: "#fff8e3",
    highway: "#f6d98e",
    highwayCasing: "#d3ab55",
    rail: "#b5b8b3",
    track: "#8b7653",
    path: "#4a535c",
    cycleway: "#0b8296",
    aerialway: "#5e666e",
    boundary: "#9a8fa6",
    label: "#3a4046",
    labelMuted: "#6c737a",
    labelStrong: "#12161a",
    labelWater: "#2f6d8e",
    halo: "#f8f9f5",
    summit: "#6b5536",
    poi: "#555d65",
    drinkingWater: "#1f7fb8",
    parking: "#2f5fc4",
    parkingInk: "#ffffff",
    shadow: "#43503f",
    highlight: "#ffffff",
    accent: "#2c3529",
    contour: "#a07d52",
    relief: [0.3, 0.46, 0.28],
  },
};

export interface OutdoorLayersInput {
  readonly variant: PaletteName;
  readonly emphasis: MapEmphasis;
  readonly vector: string;
  readonly relief: string;
}

const fonts = {
  regular: ["SofiaSans-Medium"],
  bold: ["SofiaSans-Bold"],
  italic: ["SofiaSans-MediumItalic"],
  figures: ["SofiaSansCondensed-SemiBold"],
  brand: ["Outfit-SemiBold"],
};

const name: ExpressionSpecification = ["coalesce", ["get", "name:fr"], ["get", "name:latin"], ["get", "name"]];

function zoomRamp(base: number, stops: readonly (readonly [number, number])[]): ExpressionSpecification {
  return ["interpolate", ["exponential", base], ["zoom"], ...stops.flat()] as ExpressionSpecification;
}

function classIn(...classes: string[]): ExpressionSpecification {
  return ["match", ["get", "class"], classes, true, false];
}

function subclassIn(...subclasses: string[]): ExpressionSpecification {
  return ["match", ["get", "subclass"], subclasses, true, false];
}

const notTunnel: ExpressionSpecification = ["!=", ["get", "brunnel"], "tunnel"];

interface RoadClass {
  readonly id: string;
  readonly classes: readonly string[];
  readonly minzoom: number;
  readonly width: readonly (readonly [number, number])[];
  readonly color: OutdoorColor;
  readonly casing: OutdoorColor;
}

const roadClasses: readonly RoadClass[] = [
  { id: "service", classes: ["service"], minzoom: 14, width: [[14, 0.6], [16, 2.4], [18, 6]], color: "minor", casing: "casing" },
  { id: "minor", classes: ["minor"], minzoom: 12, width: [[12, 0.5], [14, 1.6], [16, 4], [18, 10]], color: "minor", casing: "casing" },
  { id: "secondary", classes: ["secondary", "tertiary"], minzoom: 9, width: [[9, 0.5], [12, 1.4], [14, 3], [16, 6], [18, 13]], color: "major", casing: "casing" },
  { id: "primary", classes: ["primary", "trunk"], minzoom: 7, width: [[7, 0.5], [10, 1.3], [12, 2], [14, 3.6], [16, 7], [18, 15]], color: "major", casing: "casing" },
  { id: "motorway", classes: ["motorway"], minzoom: 5, width: [[5, 0.5], [8, 1.1], [12, 2.4], [14, 4], [16, 8], [18, 17]], color: "highway", casing: "highwayCasing" },
];

function roadLayers(vector: string, palette: OutdoorPalette): LayerSpecification[] {
  const casings = roadClasses.map((road): LayerSpecification => ({
    id: `road-${road.id}-casing`,
    type: "line",
    source: vector,
    "source-layer": "transportation",
    minzoom: Math.max(road.minzoom, 11),
    filter: ["all", classIn(...road.classes), notTunnel],
    layout: { "line-cap": "round", "line-join": "round" },
    paint: {
      "line-color": palette[road.casing],
      "line-width": zoomRamp(1.4, road.width.map(([zoom, width]) => [zoom, width + (zoom < 13 ? 1 : 2)])),
      "line-opacity": zoomRamp(1, [[11, 0], [12.5, 1]]),
    },
  }));
  const fills = roadClasses.map((road): LayerSpecification => ({
    id: `road-${road.id}`,
    type: "line",
    source: vector,
    "source-layer": "transportation",
    minzoom: road.minzoom,
    filter: classIn(...road.classes),
    layout: { "line-cap": "round", "line-join": "round" },
    paint: {
      "line-color": palette[road.color],
      "line-width": zoomRamp(1.4, road.width),
      "line-opacity": ["case", ["==", ["get", "brunnel"], "tunnel"], 0.45, 1],
    },
  }));
  return [...casings, ...fills];
}

function trailLayers(vector: string, palette: OutdoorPalette, emphasis: MapEmphasis): LayerSpecification[] {
  const foot = emphasis === "foot";
  const paths = subclassIn("path", "footway", "bridleway", "steps", "pedestrian");
  return [
    {
      id: "trail-track",
      type: "line",
      source: vector,
      "source-layer": "transportation",
      minzoom: 11,
      filter: classIn("track"),
      layout: { "line-join": "round" },
      paint: {
        "line-color": palette.track,
        "line-width": zoomRamp(1.4, foot ? [[11, 0.6], [14, 1.6], [16, 2.6], [18, 4.5]] : [[11, 0.5], [14, 1.2], [16, 2], [18, 3.5]]),
        "line-dasharray": [3, 1.6],
        "line-opacity": zoomRamp(1, [[11, 0.4], [13, 0.9]]),
      },
    },
    {
      id: "trail-path",
      type: "line",
      source: vector,
      "source-layer": "transportation",
      minzoom: foot ? 12 : 13,
      filter: ["all", classIn("path"), paths],
      layout: { "line-join": "round" },
      paint: {
        "line-color": palette.path,
        "line-width": zoomRamp(1.4, foot ? [[12, 0.7], [14, 1.4], [16, 2.2], [18, 3.6]] : [[13, 0.5], [16, 1.3], [18, 2.4]]),
        "line-dasharray": [2, 1.4],
        "line-opacity": zoomRamp(1, foot ? [[12, 0.45], [14, 0.85]] : [[13, 0.3], [15, 0.55]]),
      },
    },
    {
      id: "trail-cycleway",
      type: "line",
      source: vector,
      "source-layer": "transportation",
      minzoom: foot ? 13 : 11,
      filter: ["all", classIn("path"), subclassIn("cycleway")],
      layout: { "line-join": "round", "line-cap": "round" },
      paint: foot
        ? {
            "line-color": palette.path,
            "line-width": zoomRamp(1.4, [[13, 0.5], [16, 1.3], [18, 2.4]]),
            "line-dasharray": [2, 1.4],
            "line-opacity": 0.5,
          }
        : {
            "line-color": palette.cycleway,
            "line-width": zoomRamp(1.4, [[11, 0.8], [14, 1.8], [16, 3], [18, 5]]),
            "line-opacity": zoomRamp(1, [[11, 0.6], [13, 0.95]]),
          },
    },
  ];
}

function landLayers(vector: string, palette: OutdoorPalette): LayerSpecification[] {
  const cover = (id: string, classes: string[], color: string, minzoom = 0): LayerSpecification => ({
    id: `landcover-${id}`,
    type: "fill",
    source: vector,
    "source-layer": "landcover",
    minzoom,
    filter: classIn(...classes),
    paint: { "fill-color": color, "fill-antialias": false },
  });
  return [
    { id: "background", type: "background", paint: { "background-color": palette.land } },
    cover("farmland", ["farmland"], palette.farmland, 9),
    cover("grass", ["grass"], palette.grass),
    cover("wetland", ["wetland"], palette.wetland, 9),
    cover("wood", ["wood"], palette.wood),
    cover("sand", ["sand"], palette.sand),
    cover("rock", ["rock"], palette.rock),
    cover("ice", ["ice"], palette.ice),
    {
      id: "landuse-urban",
      type: "fill",
      source: vector,
      "source-layer": "landuse",
      filter: classIn("residential", "suburb", "quarter", "neighbourhood", "commercial", "industrial", "retail", "railway"),
      paint: { "fill-color": palette.urban, "fill-opacity": zoomRamp(1, [[5, 0.6], [12, 1]]) },
    },
  ];
}

function reliefLayer(relief: string, palette: OutdoorPalette): LayerSpecification {
  const [low, mid, high] = palette.relief;
  return {
    id: "relief",
    type: "hillshade",
    source: relief,
    minzoom: 9,
    maxzoom: 17,
    paint: {
      "hillshade-exaggeration": zoomRamp(1, [[9, low], [12, mid], [16, high]]),
      "hillshade-shadow-color": palette.shadow,
      "hillshade-highlight-color": palette.highlight,
      "hillshade-accent-color": palette.accent,
      "hillshade-illumination-direction": 315,
    },
  };
}

function waterLayers(vector: string, palette: OutdoorPalette): LayerSpecification[] {
  return [
    {
      id: "park-outline",
      type: "line",
      source: vector,
      "source-layer": "park",
      minzoom: 8,
      filter: classIn("national_park", "nature_reserve", "protected_area"),
      paint: { "line-color": palette.park, "line-width": zoomRamp(1.3, [[8, 0.8], [14, 2]]), "line-dasharray": [3, 2], "line-opacity": 0.6 },
    },
    {
      id: "ice-outline",
      type: "line",
      source: vector,
      "source-layer": "landcover",
      minzoom: 10,
      filter: classIn("ice"),
      paint: { "line-color": palette.iceLine, "line-width": zoomRamp(1.3, [[10, 0.5], [15, 1.4]]), "line-dasharray": [4, 2] },
    },
    {
      id: "waterway",
      type: "line",
      source: vector,
      "source-layer": "waterway",
      filter: notTunnel,
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": palette.waterway,
        "line-width": ["interpolate", ["exponential", 1.4], ["zoom"], 8, ["match", ["get", "class"], "river", 0.8, 0], 12, ["match", ["get", "class"], "river", 1.8, 0.6], 16, ["match", ["get", "class"], "river", 5, 1.8]],
        "line-opacity": ["case", ["==", ["get", "intermittent"], 1], 0.55, 1],
      },
    },
    { id: "water", type: "fill", source: vector, "source-layer": "water", filter: notTunnel, paint: { "fill-color": palette.water } },
    {
      id: "building",
      type: "fill",
      source: vector,
      "source-layer": "building",
      minzoom: 14,
      paint: { "fill-color": palette.building, "fill-opacity": zoomRamp(1, [[14, 0], [15, 0.9]]) },
    },
  ];
}

function railLayers(vector: string, palette: OutdoorPalette): LayerSpecification[] {
  return [
    {
      id: "rail",
      type: "line",
      source: vector,
      "source-layer": "transportation",
      minzoom: 10,
      filter: ["all", classIn("rail"), notTunnel],
      paint: { "line-color": palette.rail, "line-width": zoomRamp(1.4, [[10, 0.6], [14, 1.4], [18, 3]]) },
    },
    {
      id: "aerialway",
      type: "line",
      source: vector,
      "source-layer": "transportation",
      minzoom: 12,
      filter: classIn("aerialway"),
      paint: { "line-color": palette.aerialway, "line-width": zoomRamp(1.4, [[12, 0.6], [16, 1.4]]), "line-dasharray": [6, 1, 0.6, 1] },
    },
  ];
}

function boundaryLayer(vector: string, palette: OutdoorPalette): LayerSpecification {
  return {
    id: "boundary-country",
    type: "line",
    source: vector,
    "source-layer": "boundary",
    filter: ["all", ["==", ["get", "admin_level"], 2], ["!=", ["get", "maritime"], 1]],
    paint: { "line-color": palette.boundary, "line-width": zoomRamp(1.3, [[3, 0.6], [10, 1.6], [14, 2.4]]), "line-dasharray": [4, 2, 1, 2] },
  };
}

function labelLayers(vector: string, palette: OutdoorPalette): LayerSpecification[] {
  const halo = { "text-halo-color": palette.halo, "text-halo-width": 1.4, "text-halo-blur": 0.4 };
  const elevation: ExpressionSpecification = ["concat", ["to-string", ["get", "ele"]], " m"];
  const summitText: ExpressionSpecification = [
    "case",
    ["all", ["has", "ele"], ["to-boolean", name]],
    ["format", name, { "text-font": ["literal", fonts.bold] }, "\n", {}, elevation, { "text-font": ["literal", fonts.figures], "font-scale": 0.88 }],
    ["has", "ele"],
    ["format", elevation, { "text-font": ["literal", fonts.figures] }],
    ["format", name, {}],
  ];
  return [
    {
      id: "label-waterway",
      type: "symbol",
      source: vector,
      "source-layer": "waterway",
      minzoom: 12,
      layout: { "symbol-placement": "line", "text-field": name, "text-font": fonts.italic, "text-size": 11.5, "text-letter-spacing": 0.05, "symbol-spacing": 420 },
      paint: { "text-color": palette.labelWater, ...halo },
    },
    {
      id: "label-water",
      type: "symbol",
      source: vector,
      "source-layer": "water_name",
      layout: { "text-field": name, "text-font": fonts.italic, "text-size": zoomRamp(1.2, [[8, 11], [14, 14]]), "text-max-width": 7, "text-letter-spacing": 0.06 },
      paint: { "text-color": palette.labelWater, ...halo },
    },
    {
      id: "label-road",
      type: "symbol",
      source: vector,
      "source-layer": "transportation_name",
      minzoom: 13,
      filter: classIn("motorway", "trunk", "primary", "secondary", "tertiary", "minor", "track", "path"),
      layout: { "symbol-placement": "line", "text-field": name, "text-font": fonts.regular, "text-size": zoomRamp(1.2, [[13, 10.5], [17, 13]]), "symbol-spacing": 360 },
      paint: { "text-color": palette.labelMuted, ...halo },
    },
    {
      id: "poi-parking",
      type: "symbol",
      source: vector,
      "source-layer": "poi",
      minzoom: 14,
      filter: ["all", classIn("parking"), ["!=", ["get", "subclass"], "bicycle_parking"]],
      layout: {
        "icon-image": "badge",
        "icon-size": 0.78,
        "text-field": "P",
        "text-font": fonts.bold,
        "text-size": 10,
        "text-allow-overlap": true,
        "icon-allow-overlap": false,
        "symbol-sort-key": ["get", "rank"],
      },
      paint: { "icon-color": palette.parking, "text-color": palette.parkingInk },
    },
    {
      id: "poi-water",
      type: "symbol",
      source: vector,
      "source-layer": "poi",
      minzoom: 14,
      filter: classIn("drinking_water"),
      layout: { "icon-image": "water", "icon-size": 0.85 },
      paint: { "icon-color": palette.drinkingWater, "icon-halo-color": palette.halo, "icon-halo-width": 1.2 },
    },
    {
      id: "poi-hut",
      type: "symbol",
      source: vector,
      "source-layer": "poi",
      minzoom: 12,
      filter: ["any", classIn("shelter"), ["all", classIn("lodging"), subclassIn("alpine_hut", "wilderness_hut")]],
      layout: {
        "icon-image": ["case", ["==", ["get", "class"], "shelter"], "shelter", "hut"],
        "icon-size": 0.9,
        "text-field": ["step", ["zoom"], "", 13, name],
        "text-font": fonts.regular,
        "text-size": 11,
        "text-anchor": "top",
        "text-offset": [0, 0.9],
        "text-max-width": 8,
        "text-optional": true,
      },
      paint: { "icon-color": palette.summit, "icon-halo-color": palette.halo, "icon-halo-width": 1.2, "text-color": palette.poi, ...halo },
    },
    {
      id: "summit-saddle",
      type: "symbol",
      source: vector,
      "source-layer": "mountain_peak",
      minzoom: 12,
      filter: classIn("saddle"),
      layout: {
        "icon-image": "saddle",
        "icon-size": 0.8,
        "text-field": summitText,
        "text-font": fonts.regular,
        "text-size": 11,
        "text-anchor": "top",
        "text-offset": [0, 0.8],
        "text-max-width": 8,
        "text-optional": true,
      },
      paint: { "icon-color": palette.summit, "icon-halo-color": palette.halo, "icon-halo-width": 1.2, "text-color": palette.poi, ...halo },
    },
    {
      id: "summit-peak",
      type: "symbol",
      source: vector,
      "source-layer": "mountain_peak",
      minzoom: 9,
      filter: classIn("peak", "volcano"),
      layout: {
        "icon-image": "peak",
        "icon-size": zoomRamp(1, [[9, 0.6], [13, 0.85]]),
        "text-field": ["step", ["zoom"], ["format", name, {}], 11, summitText],
        "text-font": fonts.bold,
        "text-size": zoomRamp(1, [[9, 10.5], [14, 12.5]]),
        "text-anchor": "top",
        "text-offset": [0, 0.75],
        "text-max-width": 8,
        "text-line-height": 1.1,
        "text-optional": true,
        "symbol-sort-key": ["-", 0, ["to-number", ["get", "ele"], 0]],
      },
      paint: { "icon-color": palette.summit, "icon-halo-color": palette.halo, "icon-halo-width": 1.2, "text-color": palette.summit, ...halo },
    },
    {
      id: "place-minor",
      type: "symbol",
      source: vector,
      "source-layer": "place",
      minzoom: 11,
      filter: classIn("hamlet", "isolated_dwelling", "neighbourhood", "quarter", "suburb", "locality"),
      layout: { "text-field": name, "text-font": fonts.regular, "text-size": zoomRamp(1.2, [[11, 10.5], [16, 13]]), "text-max-width": 8 },
      paint: { "text-color": palette.labelMuted, ...halo },
    },
    {
      id: "place-village",
      type: "symbol",
      source: vector,
      "source-layer": "place",
      minzoom: 9,
      filter: classIn("village"),
      layout: { "text-field": name, "text-font": fonts.bold, "text-size": zoomRamp(1.2, [[9, 10.5], [15, 14]]), "text-max-width": 8 },
      paint: { "text-color": palette.label, ...halo },
    },
    {
      id: "place-town",
      type: "symbol",
      source: vector,
      "source-layer": "place",
      minzoom: 7,
      filter: classIn("town"),
      layout: { "text-field": name, "text-font": fonts.bold, "text-size": zoomRamp(1.2, [[7, 11], [14, 16]]), "text-max-width": 8 },
      paint: { "text-color": palette.labelStrong, ...halo },
    },
    {
      id: "place-city",
      type: "symbol",
      source: vector,
      "source-layer": "place",
      minzoom: 4,
      filter: classIn("city"),
      layout: {
        "text-field": name,
        "text-font": fonts.brand,
        "text-size": zoomRamp(1.2, [[4, 11], [8, 15], [13, 21]]),
        "text-max-width": 8,
        "symbol-sort-key": ["get", "rank"],
      },
      paint: { "text-color": palette.labelStrong, ...halo, "text-halo-width": 1.8 },
    },
    {
      id: "place-country",
      type: "symbol",
      source: vector,
      "source-layer": "place",
      maxzoom: 9,
      filter: classIn("country"),
      layout: { "text-field": name, "text-font": fonts.bold, "text-size": zoomRamp(1.2, [[2, 10], [6, 14]]), "text-transform": "uppercase", "text-letter-spacing": 0.18, "text-max-width": 7 },
      paint: { "text-color": palette.labelMuted, ...halo },
    },
  ];
}

/** Obnixe Outdoor, drawn on the OpenMapTiles schema (DEC-12, MAP-002, MAP-005). */
export function outdoorLayers({ variant, emphasis, vector, relief }: OutdoorLayersInput): LayerSpecification[] {
  const palette = outdoorPalettes[variant];
  return [
    ...landLayers(vector, palette),
    reliefLayer(relief, palette),
    ...waterLayers(vector, palette),
    ...railLayers(vector, palette),
    ...roadLayers(vector, palette),
    ...trailLayers(vector, palette, emphasis),
    boundaryLayer(vector, palette),
    ...labelLayers(vector, palette),
  ];
}

/** The base layer the contour lines are drawn under: above the ground and the relief, below water, roads and labels. */
export const contourAnchor = "park-outline";

/** Contour lines from a GeoJSON source of `ele` and `master` lines, master lines labelled with their elevation (`MAP-006`). */
export function contourLayers(variant: PaletteName, source: string): LayerSpecification[] {
  const palette = outdoorPalettes[variant];
  const master: ExpressionSpecification = ["==", ["get", "master"], true];
  return [
    {
      id: "contour-line",
      type: "line",
      source,
      minzoom: 12,
      layout: { "line-join": "round" },
      paint: {
        "line-color": palette.contour,
        "line-width": ["interpolate", ["exponential", 1.4], ["zoom"], 12, ["case", master, 1, 0.5], 16, ["case", master, 1.8, 1]],
        "line-opacity": zoomRamp(1, [[12, 0.5], [14, 0.8]]),
      },
    },
    {
      id: "contour-label",
      type: "symbol",
      source,
      minzoom: 13,
      filter: master,
      layout: {
        "symbol-placement": "line",
        "text-field": ["concat", ["to-string", ["get", "ele"]], " m"],
        "text-font": fonts.figures,
        "text-size": 10,
        "symbol-spacing": 360,
        "text-max-angle": 30,
      },
      paint: { "text-color": palette.contour, "text-halo-color": palette.halo, "text-halo-width": 1.2 },
    },
  ];
}
