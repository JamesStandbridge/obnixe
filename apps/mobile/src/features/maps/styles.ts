import type { StyleSpecification } from "@maplibre/maplibre-gl-style-spec";
import type { DemTileKey } from "@obnixe/core";
import type { MapStyle, SportKey } from "@obnixe/schema";
import { mapAssetsUrl } from "@/features/maps/assets";
import { contourAnchor, contourLayers, outdoorLayers, outdoorPalettes } from "@/features/maps/outdoorStyle";
import type { MapEmphasis } from "@/features/maps/outdoorStyle";
import type { MapContours } from "@/features/maps/surface";
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

export type OfflineTileKind = "vector" | "imagery";

export interface OfflineTiles {
  readonly kind: OfflineTileKind;
  readonly zoom: ZoomRange;
}

export interface OfflineCoverage {
  /** The style's own tiles, downloaded over this range; MapLibre overzooms the last level. */
  readonly base: OfflineTiles;
  /** Absent when the base has no relief source. */
  readonly relief: ZoomRange | null;
}

export interface MapBase {
  /** An inline style, or the URL of a remote style that MapLibre fetches and caches. */
  readonly style: StyleSpecification | string;
  readonly attribution: readonly MapAttribution[];
  readonly offline: OfflineCoverage;
  /** Absent when the base draws its own contour lines or none (`MAP-006`). */
  readonly contours: MapContours | null;
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

/** BD ORTHO through the Géoplateforme WMTS, open licence, no key (`MAP-007`); IGN serves it up to z19. */
const orthoIgn = {
  tiles: "https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=ORTHOIMAGERY.ORTHOPHOTOS&STYLE=normal&TILEMATRIXSET=PM&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}&FORMAT=image/jpeg",
  maxzoom: 19,
  attribution: planIgn.attribution,
} as const;

const vectorOffline: OfflineTiles = { kind: "vector", zoom: { min: 5, max: 14 } };
const imageryOffline: OfflineTiles = { kind: "imagery", zoom: { min: 5, max: 16 } };

/** The Terrain Tiles PNG the DEM correction and the contour lines sample on the device (`ELE-003`, `MAP-006`). */
export function demTileUrl({ zoom, x, y }: DemTileKey): string {
  return terrainTiles.tiles.replace("{z}", String(zoom)).replace("{x}", String(x)).replace("{y}", String(y));
}

export interface MapStyleOption {
  readonly value: MapStyle;
  readonly label: string;
  readonly detail: string;
}

export const mapStyleOptions: readonly MapStyleOption[] = [
  { value: "obnixe_outdoor", label: "Obnixe Outdoor", detail: "Monde entier, relief et sentiers" },
  { value: "plan_ign", label: "Plan IGN", detail: "France" },
  { value: "ortho_ign", label: "Vue aérienne IGN", detail: "France, photographies BD ORTHO" },
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
    case "ski_touring":
    case "nordic_ski":
    case "alpine_ski":
    case "paddle":
      return "foot";
    case "bike":
    case "inline_skate":
      return "bike";
    default: {
      const unreachable: never = sport;
      return unreachable;
    }
  }
}

/** The GeoJSON source the contour layers read (`MAP-006`). */
export const contourSource = "obnixe-contours";

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

/** Aerial imagery alone: the overlays bring the track, the glyphs and sprite serve their labels and icons. */
export function orthoStyle(): StyleSpecification {
  return {
    version: 8,
    name: "BD ORTHO",
    glyphs: `${mapAssetsUrl}/glyphs/{fontstack}/{range}.pbf`,
    sprite: `${mapAssetsUrl}/sprites/obnixe`,
    sources: { ortho: { type: "raster", tiles: [orthoIgn.tiles], tileSize: 256, maxzoom: orthoIgn.maxzoom } },
    layers: [
      { id: "background", type: "background", paint: { "background-color": "#1b2024" } },
      { id: "ortho", type: "raster", source: "ortho" },
    ],
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
        offline: { base: vectorOffline, relief: { min: vectorOffline.zoom.min, max: terrainTiles.maxzoom } },
        contours: { layers: contourLayers(variant, contourSource), beforeId: contourAnchor },
      };
    case "plan_ign":
      return { style: planIgn.style, attribution: planIgn.attribution, offline: { base: vectorOffline, relief: null }, contours: null };
    case "ortho_ign":
      return { style: orthoStyle(), attribution: orthoIgn.attribution, offline: { base: imageryOffline, relief: null }, contours: null };
    default: {
      const unreachable: never = mapStyle;
      return unreachable;
    }
  }
}
