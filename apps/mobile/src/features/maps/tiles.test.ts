import { describe, expect, it } from "vitest";
import { resolveMapBase } from "@/features/maps/styles";
import { bufferedBounds, estimateRegion, maxRegionTiles, tileCount } from "@/features/maps/tiles";
import type { Bounds } from "@/features/maps/tiles";

const chamonix: Bounds = [6.75, 45.8, 7.1, 46.05];
const world: Bounds = [-180, -85.051129, 180, 85.051129];

describe("tiles", () => {
  it("counts the tiles covering a rectangle", () => {
    expect(tileCount(world, 0)).toBe(1);
    expect(tileCount(world, 3)).toBe(64);
    expect(tileCount([0.0001, 0.0001, 0.0002, 0.0002], 10)).toBe(1);
    expect(tileCount([-0.0001, -0.0001, 0.0001, 0.0001], 10)).toBe(4);
  });

  it("keeps a 30 km mountain region within the size the spec allows", () => {
    const outdoor = resolveMapBase({ mapStyle: "obnixe_outdoor", variant: "dark", emphasis: "foot" });
    const square: Bounds = [6.7, 45.8, 7.087, 46.07];
    const estimate = estimateRegion(square, outdoor.offline);
    expect(estimate.tiles).toBeLessThan(maxRegionTiles);
    expect(estimate.bytes).toBeGreaterThan(20 * 1024 * 1024);
    expect(estimate.bytes).toBeLessThan(120 * 1024 * 1024);
  });

  it("adds relief tiles only for bases that have relief", () => {
    const outdoor = resolveMapBase({ mapStyle: "obnixe_outdoor", variant: "dark", emphasis: "foot" });
    const ign = resolveMapBase({ mapStyle: "plan_ign", variant: "dark", emphasis: "foot" });
    const withRelief = estimateRegion(chamonix, outdoor.offline);
    const withoutRelief = estimateRegion(chamonix, ign.offline);
    let reliefTiles = 0;
    for (let zoom = 5; zoom <= 12; zoom += 1) reliefTiles += tileCount(chamonix, zoom);
    expect(withRelief.tiles - withoutRelief.tiles).toBe(reliefTiles);
  });

  it("widens the points' bounding box by the buffer", () => {
    expect(bufferedBounds([], 1000)).toBeNull();
    const bounds = bufferedBounds(
      [
        { latitude: 45.9, longitude: 6.8 },
        { latitude: 46, longitude: 6.9 },
      ],
      1113.2,
    );
    expect(bounds?.[1]).toBeCloseTo(45.89, 6);
    expect(bounds?.[3]).toBeCloseTo(46.01, 6);
    const [west = 0, , east = 0] = bounds ?? [];
    expect(east - west).toBeGreaterThan(0.1 + 2 * 0.01 / Math.cos((46.01 * Math.PI) / 180) - 1e-9);
  });
});
