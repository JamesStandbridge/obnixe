import type { DemTileKey } from "@obnixe/core";
import type { Bounds } from "@/features/maps/tiles";

/** The DEM zoom and the spacing of the lines drawn at a map zoom (`MAP-006`): 50 m at z12, 20 m at z13, 10 m from z14. */
export interface ContourLevel {
  readonly demZoom: number;
  readonly interval: number;
  readonly masterInterval: number;
}

/** Above this many tiles in view the map is zoomed out of the contour range. */
export const maxContourTiles = 12;

export function contourLevel(zoom: number): ContourLevel | null {
  if (zoom < 12) return null;
  if (zoom < 13) return { demZoom: 12, interval: 50, masterInterval: 250 };
  if (zoom < 14) return { demZoom: 12, interval: 20, masterInterval: 100 };
  return { demZoom: 13, interval: 10, masterInterval: 50 };
}

const maxLatitude = 85.051129;

function column(longitude: number, zoom: number): number {
  return Math.floor(((longitude + 180) / 360) * 2 ** zoom);
}

function row(latitude: number, zoom: number): number {
  const angle = (Math.max(-maxLatitude, Math.min(maxLatitude, latitude)) * Math.PI) / 180;
  return Math.floor(((1 - Math.log(Math.tan(angle) + 1 / Math.cos(angle)) / Math.PI) / 2) * 2 ** zoom);
}

/** The DEM tiles under a view, west to east then north to south; empty above `maxContourTiles`. */
export function contourTilesIn([west, south, east, north]: Bounds, zoom: number): readonly DemTileKey[] {
  const last = 2 ** zoom - 1;
  const left = Math.max(0, column(west, zoom));
  const right = Math.min(last, column(east, zoom));
  const top = Math.max(0, row(north, zoom));
  const bottom = Math.min(last, row(south, zoom));
  if ((right - left + 1) * (bottom - top + 1) > maxContourTiles) return [];
  const keys: DemTileKey[] = [];
  for (let y = top; y <= bottom; y += 1) for (let x = left; x <= right; x += 1) keys.push({ zoom, x, y });
  return keys;
}

export interface ContourNeighbours {
  readonly east: DemTileKey;
  readonly south: DemTileKey;
  readonly southEast: DemTileKey;
}

/** The neighbours whose first column and row close a tile's grid. */
export function contourNeighbours({ zoom, x, y }: DemTileKey): ContourNeighbours {
  const size = 2 ** zoom;
  const east = (x + 1) % size;
  const south = Math.min(size - 1, y + 1);
  return { east: { zoom, x: east, y }, south: { zoom, x, y: south }, southEast: { zoom, x: east, y: south } };
}
