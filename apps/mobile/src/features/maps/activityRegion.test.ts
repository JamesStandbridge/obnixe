import { describe, expect, it } from "vitest";
import type { Id } from "@obnixe/schema";
import { activityArea, activityRegionBounds, regionOutline, routeArea } from "@/features/maps/activityRegion";
import type { ActivityArea } from "@/features/maps/activityRegion";
import { db } from "../../../test/mocks/database.ts";

const area: ActivityArea = {
  title: "Sortie longue",
  corners: [
    { latitude: 45.1, longitude: 5.6 },
    { latitude: 45.2, longitude: 5.8 },
  ],
};

describe("offline region around an activity (MAP-031)", () => {
  it("widens the activity extent by the chosen margin", () => {
    const [west, south, east, north] = activityRegionBounds(area, "2") ?? [0, 0, 0, 0];
    expect(south).toBeCloseTo(45.1 - 2000 / 111_320, 6);
    expect(north).toBeCloseTo(45.2 + 2000 / 111_320, 6);
    expect(west).toBeLessThan(5.6 - 2000 / 111_320);
    expect(east).toBeGreaterThan(5.8 + 2000 / 111_320);
    const [wider] = activityRegionBounds(area, "10") ?? [0];
    expect(wider).toBeLessThan(west);
  });

  it("outlines the region as a closed ring", () => {
    const outline = JSON.parse(regionOutline([5, 45, 6, 46])) as { geometry: { coordinates: number[][][] } };
    expect(outline.geometry.coordinates[0]).toEqual([
      [5, 45],
      [6, 45],
      [6, 46],
      [5, 46],
      [5, 45],
    ]);
  });

  it("has nothing to frame for a session without a track", () => {
    expect(activityArea(db(), "missing" as Id)).toBeNull();
  });
});

describe("offline region around a route (RTE-006)", () => {
  it("frames the route's extent under its name", () => {
    expect(routeArea({ name: "Tour de la Bastille", bbox: { south: 451_000_000, west: 56_000_000, north: 452_000_000, east: 58_000_000 } })).toEqual({ title: "Tour de la Bastille", corners: area.corners });
  });
});
