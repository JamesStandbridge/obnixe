import type { StyleSpecification } from "@maplibre/maplibre-gl-style-spec";
import type { MapStyle, SportKey } from "@obnixe/schema";
import { mapAssetsUrl } from "@/features/maps/assets";
import { outdoorLayers, outdoorPalettes } from "@/features/maps/outdoorStyle";
import type { MapEmphasis } from "@/features/maps/outdoorStyle";
import type { PaletteName } from "@/ui/tokens";

/*
 * The only module that names tile providers (MAP-001). Every source is free, keyless and allows app use (DEC-12, MAP-003).
 */

export interface MapAttribution {
  readonly label: string;
  readonly url: string;
}

export interface ZoomRange {
  readonly min: number;
  readonly max: number;
}

export interface OfflineCoverage {
  readonly vector: ZoomRange;
  /** Absent when the base has no relief source. */
  readonly relief: ZoomRange | null;
}

export interface MapBase {
  /** An inline style, or the URL of a remote style that MapLibre fetches and caches. */
  readonly style: StyleSpecification | string;
  readonly attribution: readonly MapAttribution[];
  readonly offline: OfflineCoverage;
}

const openFreeMap = {
  tileJson: "https://tiles.openfreemap.org/planet",
  attribution: [
    { label: "© OpenFreeMap", url: "https://openfreemap.org" },
    { label: "© OpenMapTiles", url: "https://www.openmaptiles.org" },
    { label: "© OpenStreetMap contributors", url: "https://www.openstreetmap.org/copyright" },
  ],
} as const;

/** Relief stops at z12, offline and online alike, so a downloaded region shows the same shading up to z17 (MAP-031). */
const terrainTiles = {
  tiles: "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png",
  maxzoom: 12,
  attribution: [{ label: "Relief : Terrain Tiles, AWS Open Data", url: "https://registry.opendata.aws/terrain-tiles/" }],
} as const;

const planIgn = {
  style: "https://data.geopf.fr/annexes/ressources/vectorTiles/styles/PLAN.IGN/standard.json",
  attribution: [{ label: "© IGN", url: "https://geoservices.ign.fr/cgu-licences" }],
} as const;

const vectorOffline: ZoomRange = { min: 5, max: 14 };

export interface MapStyleOption {
  readonly value: MapStyle;
  readonly label: string;
  readonly detail: string;
}

export const mapStyleOptions: readonly MapStyleOption[] = [
  { value: "obnixe_outdoor", label: "Obnixe Outdoor", detail: "Monde entier, relief et sentiers" },
  { value: "plan_ign", label: "Plan IGN", detail: "France" },
];

export function emphasisOf(sport: SportKey | null): MapEmphasis {
  switch (sport) {
    case null:
    case "run":
    case "trail":
    case "walk":
    case "hike":
    case "climb":
    case "strength":
    case "swim":
    case "yoga":
      return "foot";
    case "bike":
      return "bike";
    default: {
      const unreachable: never = sport;
      return unreachable;
    }
  }
}

export interface MapBaseInput {
  readonly mapStyle: MapStyle;
  readonly variant: PaletteName;
  readonly emphasis: MapEmphasis;
}

export function outdoorStyle(variant: PaletteName, emphasis: MapEmphasis): StyleSpecification {
  return {
    version: 8,
    name: `Obnixe Outdoor ${variant}`,
    glyphs: `${mapAssetsUrl}/glyphs/{fontstack}/{range}.pbf`,
    sprite: `${mapAssetsUrl}/sprites/obnixe`,
    sources: {
      openmaptiles: { type: "vector", url: openFreeMap.tileJson },
      relief: { type: "raster-dem", tiles: [terrainTiles.tiles], encoding: "terrarium", tileSize: 256, maxzoom: terrainTiles.maxzoom },
    },
    layers: outdoorLayers({ variant, emphasis, vector: "openmaptiles", relief: "relief" }),
  };
}

/** Plain ground for when no base style can load (MAP-032). */
export function blankStyle(variant: PaletteName): StyleSpecification {
  return { version: 8, name: "Obnixe blank", sources: {}, layers: [{ id: "background", type: "background", paint: { "background-color": outdoorPalettes[variant].land } }] };
}

export function resolveMapBase({ mapStyle, variant, emphasis }: MapBaseInput): MapBase {
  switch (mapStyle) {
    case "obnixe_outdoor":
      return {
        style: outdoorStyle(variant, emphasis),
        attribution: [...openFreeMap.attribution, ...terrainTiles.attribution],
        offline: { vector: vectorOffline, relief: { min: vectorOffline.min, max: terrainTiles.maxzoom } },
      };
    case "plan_ign":
      return { style: planIgn.style, attribution: planIgn.attribution, offline: { vector: vectorOffline, relief: null } };
    default: {
      const unreachable: never = mapStyle;
      return unreachable;
    }
  }
}
