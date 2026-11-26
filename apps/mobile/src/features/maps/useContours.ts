import { useEffect, useMemo, useState } from "react";
import { demTileName } from "@obnixe/core";
import type { DemTileKey } from "@obnixe/core";
import { contourGrid, contourGridSize } from "@/features/maps/contourLines";
import { storeContours, storedContours, trimContours } from "@/features/maps/contourStore";
import { contourLevel, contourNeighbours, contourTilesIn } from "@/features/maps/contourTiles";
import type { ContourLevel } from "@/features/maps/contourTiles";
import { traceContours } from "@/features/maps/contourWorker";
import { demTile, demTilesOf } from "@/features/maps/demTiles";
import { contourSource } from "@/features/maps/styles";
import type { MapContours, MapOverlay, MapView } from "@/features/maps/surface";

/** Traced tiles kept in memory, by `contourName`. */
const tracedLimit = 64;
const traced = new Map<string, string>();

function contourName(key: DemTileKey, level: ContourLevel): string {
  return `${demTileName(key).replaceAll("/", "-")}-${level.interval}`;
}

function remember(name: string, features: string): void {
  traced.delete(name);
  traced.set(name, features);
  if (traced.size <= tracedLimit) return;
  const oldest = traced.keys().next();
  if (oldest.done !== true) traced.delete(oldest.value);
}

/** The features of a tile from memory, the file cache or a new tracing; null while its DEM tile cannot be had. */
async function contoursOf(key: DemTileKey, level: ContourLevel): Promise<string | null> {
  const name = contourName(key, level);
  const known = traced.get(name);
  if (known !== undefined) return known;
  const stored = await storedContours(name);
  if (stored !== null) {
    remember(name, stored);
    return stored;
  }
  const tile = await demTile(key);
  if (tile === null) return null;
  const neighbours = contourNeighbours(key);
  const [east, south, southEast] = await demTilesOf([neighbours.east, neighbours.south, neighbours.southEast]);
  const grid = contourGrid({ tile, east: east ?? null, south: south ?? null, southEast: southEast ?? null });
  const features = await traceContours(grid, contourGridSize, { key, interval: level.interval, masterInterval: level.masterInterval });
  remember(name, features);
  await storeContours(name, features);
  return features;
}

/** The contour lines under the view from z12, tile by tile as they are traced (`MAP-006`); null without contours. */
export function useContours(contours: MapContours | null, view: MapView | null): MapOverlay | null {
  const level = contours === null || view === null ? null : contourLevel(view.zoom);
  const keys = level === null || view === null ? [] : contourTilesIn(view.bounds, level.demZoom);
  const names = keys.map((key) => (level === null ? "" : contourName(key, level))).join(",");
  const [version, setVersion] = useState(0);

  useEffect(() => {
    if (level === null || keys.length === 0) return;
    let cancelled = false;
    void (async () => {
      let traces = 0;
      for (const key of keys) {
        if (cancelled) return;
        if (traced.has(contourName(key, level))) continue;
        const features = await contoursOf(key, level);
        if (features === null || cancelled) continue;
        traces += 1;
        setVersion((current) => current + 1);
      }
      if (traces > 0) trimContours();
    })();
    return () => {
      cancelled = true;
    };
    // `names` stands for `keys` and `level`, new objects on every render.
  }, [names]);

  return useMemo(() => {
    if (contours === null || names === "") return null;
    const features = names.split(",").flatMap((name) => {
      const tile = traced.get(name);
      return tile === undefined || tile === "" ? [] : [tile];
    });
    return {
      id: contourSource,
      data: `{"type":"FeatureCollection","features":[${features.join(",")}]}`,
      lineMetrics: false,
      layers: contours.layers,
      beforeId: contours.beforeId,
    };
  }, [contours, names, version]);
}
