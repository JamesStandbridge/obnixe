import { describe, expect, it } from "vitest";
import { ellipsoidDistance } from "@obnixe/core";
import type { MaskZone } from "@obnixe/core";
import { metersPerPixel } from "@/features/maps/viewport";
import { circleRing, radiusPixels, zoneCenter, zonesBounds, zonesGeoJson } from "@/features/privacy/zoneShapes";

const home: MaskZone = { latitudeE7: 459_237_000, longitudeE7: 68_695_000, radiusMeters: 300, maskScalePermille: 1200 };
const work: MaskZone = { latitudeE7: 459_000_000, longitudeE7: 69_200_000, radiusMeters: 1000, maskScalePermille: 1000 };

interface Feature {
  readonly properties: { readonly kind: string };
  readonly geometry: { readonly type: string; readonly coordinates: readonly (readonly (readonly [number, number])[])[] };
}

describe("zone shapes", () => {
  it("draws a closed ring at the radius from the center", () => {
    const center = zoneCenter(home);
    const ring = circleRing(center, 300);
    expect(ring[0]).toEqual(ring[ring.length - 1]);
    for (const [longitude, latitude] of ring) expect(ellipsoidDistance(center.latitude, center.longitude, latitude, longitude)).toBeCloseTo(300, 3);
  });

  it("shows each zone as its masked area and its chosen radius (PRV-012)", () => {
    const { features } = JSON.parse(zonesGeoJson([home, work])) as { readonly features: readonly Feature[] };
    expect(features.map((feature) => feature.properties.kind)).toEqual(["masked", "radius", "masked", "radius"]);
    const center = zoneCenter(home);
    const [masked, radius] = features.map((feature) => feature.geometry.coordinates[0]?.[0] ?? [0, 0]);
    expect(ellipsoidDistance(center.latitude, center.longitude, masked?.[1] ?? 0, masked?.[0] ?? 0)).toBeCloseTo(360, 3);
    expect(ellipsoidDistance(center.latitude, center.longitude, radius?.[1] ?? 0, radius?.[0] ?? 0)).toBeCloseTo(300, 3);
  });

  it("bounds every masked area", () => {
    expect(zonesBounds([])).toBeNull();
    const [west = 0, south = 0, east = 0, north = 0] = zonesBounds([home, work]) ?? [];
    const homeCenter = zoneCenter(home);
    const workCenter = zoneCenter(work);
    expect(Math.abs(ellipsoidDistance(homeCenter.latitude, homeCenter.longitude, north, homeCenter.longitude) - 360)).toBeLessThan(1);
    expect(Math.abs(ellipsoidDistance(workCenter.latitude, workCenter.longitude, south, workCenter.longitude) - 1000)).toBeLessThan(3);
    expect(west).toBeLessThan(homeCenter.longitude);
    expect(east).toBeGreaterThan(workCenter.longitude);
  });

  it("converts a radius to screen pixels at the view's zoom", () => {
    expect(radiusPixels(300, 45.9, 14)).toBeCloseTo(300 / metersPerPixel(45.9, 14), 9);
    expect(radiusPixels(300, 45.9, 15)).toBeCloseTo(2 * radiusPixels(300, 45.9, 14), 9);
  });
});
