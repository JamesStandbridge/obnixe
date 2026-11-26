import { describe, expect, it } from "vitest";
import { demTileSize } from "@obnixe/core";
import type { DemTile, DemTileKey } from "@obnixe/core";
import { contourFeatures, contourGrid, contourGridSize } from "@/features/maps/contourLines";
import { contourLevel, contourNeighbours, contourTilesIn, maxContourTiles } from "@/features/maps/contourTiles";
import { viewAround } from "@/features/maps/viewport";

interface ContourFeature {
  readonly properties: { readonly ele: number; readonly master: boolean };
  readonly geometry: { readonly type: "LineString"; readonly coordinates: readonly (readonly [number, number])[] };
}

type Terrain = (x: number, y: number) => number;

function tileOf(key: DemTileKey, terrain: Terrain): DemTile {
  const elevation = new Float32Array(demTileSize * demTileSize);
  for (let row = 0; row < demTileSize; row += 1) {
    for (let column = 0; column < demTileSize; column += 1) elevation[row * demTileSize + column] = terrain(key.x * demTileSize + column, key.y * demTileSize + row);
  }
  return { key, elevation };
}

function featuresOf(key: DemTileKey, terrain: Terrain, interval: number, masterInterval: number): readonly ContourFeature[] {
  const { east, south, southEast } = contourNeighbours(key);
  const grid = contourGrid({ tile: tileOf(key, terrain), east: tileOf(east, terrain), south: tileOf(south, terrain), southEast: tileOf(southEast, terrain) });
  const features = contourFeatures(grid, contourGridSize, { key, interval, masterInterval });
  return JSON.parse(`[${features}]`) as ContourFeature[];
}

const chamonix: DemTileKey = { zoom: 13, x: 4248, y: 2913 };

describe("contour lines (MAP-006)", () => {
  it("rings a summit once per level, master lines every fifth", () => {
    const centerX = chamonix.x * demTileSize + 128;
    const centerY = chamonix.y * demTileSize + 128;
    const summit: Terrain = (x, y) => 1500 - Math.hypot(x - centerX, y - centerY) * 4;
    const features = featuresOf(chamonix, summit, 10, 50);
    const inside = 1500 - 4 * 127;
    const rings = features.filter((feature) => feature.properties.ele >= inside).map((feature) => feature.properties.ele);
    expect(Math.max(...rings)).toBeGreaterThanOrEqual(1490);
    expect(new Set(rings).size).toBe(rings.length);
    for (const feature of features) {
      const coordinates = feature.geometry.coordinates;
      if (feature.properties.ele >= inside) expect(coordinates[0]).toEqual(coordinates[coordinates.length - 1]);
      expect(feature.properties.master).toBe(feature.properties.ele % 50 === 0);
    }
  });

  it("draws one straight line per level across a slope and none at or under the sea", () => {
    const slope: Terrain = (x) => (x - chamonix.x * demTileSize) * 0.5 - 20;
    const features = featuresOf(chamonix, slope, 20, 100);
    expect(features.map((feature) => feature.properties.ele)).toEqual([20, 40, 60, 80, 100]);
    for (const feature of features) {
      const longitudes = feature.geometry.coordinates.map(([longitude]) => longitude);
      expect(Math.max(...longitudes) - Math.min(...longitudes)).toBeLessThan(1e-6);
      expect(feature.geometry.coordinates).toHaveLength(2);
    }
  });

  it("ends the lines of neighbouring tiles on the same points", () => {
    const hills: Terrain = (x, y) => 1200 + 80 * Math.sin(x / 37) + 60 * Math.cos(y / 23);
    const west = featuresOf(chamonix, hills, 20, 100);
    const east = featuresOf({ ...chamonix, x: chamonix.x + 1 }, hills, 20, 100);
    const ends = (features: readonly ContourFeature[]) =>
      new Set(features.flatMap((feature) => [feature.geometry.coordinates[0], feature.geometry.coordinates[feature.geometry.coordinates.length - 1]].map((point) => JSON.stringify(point))));
    const seam = (chamonix.x + 1) / 2 ** chamonix.zoom;
    const westEnds = [...ends(west)].filter((point) => {
      const [longitude] = JSON.parse(point) as [number, number];
      return Math.abs((longitude + 180) / 360 - seam) < 0.6 / (demTileSize * 2 ** chamonix.zoom);
    });
    expect(westEnds.length).toBeGreaterThan(10);
    const eastEnds = ends(east);
    for (const point of westEnds) expect(eastEnds.has(point), point).toBe(true);
  });

  it("closes a missing neighbour with the tile's own edge", () => {
    const tile = tileOf(chamonix, (x) => x);
    const grid = contourGrid({ tile, east: null, south: null, southEast: null });
    expect(grid[demTileSize]).toBe(grid[demTileSize - 1]);
    expect(grid[contourGridSize * contourGridSize - 1]).toBe(grid[(demTileSize - 1) * contourGridSize + demTileSize]);
  });

  it("spaces lines 50 m at z12, 20 m at z13 and 10 m from z14, none below z12", () => {
    expect(contourLevel(11.9)).toBeNull();
    expect(contourLevel(12)).toEqual({ demZoom: 12, interval: 50, masterInterval: 250 });
    expect(contourLevel(13.5)).toEqual({ demZoom: 12, interval: 20, masterInterval: 100 });
    expect(contourLevel(16)).toEqual({ demZoom: 13, interval: 10, masterInterval: 50 });
  });

  it("takes the DEM tiles of a phone-sized view, and none when zoomed too far out", () => {
    const camera = { center: [6.87, 45.92] as const, zoom: 14.2 };
    const view = viewAround(camera, { width: 400, height: 850 });
    expect(view.bounds[0]).toBeLessThan(6.87);
    expect(view.bounds[2]).toBeGreaterThan(6.87);
    const tiles = contourTilesIn(view.bounds, 13);
    expect(tiles.length).toBeGreaterThan(0);
    expect(tiles.length).toBeLessThanOrEqual(maxContourTiles);
    expect(contourTilesIn(viewAround({ ...camera, zoom: 10 }, { width: 400, height: 850 }).bounds, 13)).toEqual([]);
  });
});
