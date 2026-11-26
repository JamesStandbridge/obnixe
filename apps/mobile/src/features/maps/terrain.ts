import { demCorrectionZoom, demRoutePath, demTilesFor, sampleTerrarium } from "@obnixe/core";
import type { FixColumns, RoutePath, TerrainColumns } from "@obnixe/core";
import { loadDemTiles } from "@/features/maps/demTiles";

/** The DEM altitude under a track's fixes (`ELE-003`); null without fixes or when a tile cannot be downloaded. */
export async function terrainUnder(fixes: FixColumns): Promise<TerrainColumns | null> {
  if (fixes.length === 0) return null;
  const tiles = await loadDemTiles(demCorrectionZoom, demTilesFor(fixes.latitudeE7, fixes.longitudeE7, demCorrectionZoom));
  return tiles === null ? null : sampleTerrarium(fixes, tiles);
}

/** A route given the DEM altitude of its points (`ELE-003`, `RTE-001`); null when a tile cannot be downloaded. */
export async function demRoute(path: RoutePath): Promise<RoutePath | null> {
  if (path.length === 0) return null;
  const tiles = await loadDemTiles(demCorrectionZoom, demTilesFor(path.latitudeE7, path.longitudeE7, demCorrectionZoom));
  return tiles === null ? null : demRoutePath(path, tiles);
}
