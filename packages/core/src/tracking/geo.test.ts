import { describe, expect, it } from "vitest";
import { Geodesic } from "geographiclib-geodesic";
import { BoundingBoxBuilder, displace, eastNorthBetween, ellipsoidDistance, meridianRadius, parallelRadius } from "./geo.ts";
import { createRandom } from "./testing/random.ts";

describe("geo", () => {
  it("matches the Karney geodesic within 1e-6 relative error for segments under 1 km (GPS-036)", () => {
    const random = createRandom(36);
    let worst = 0;
    for (let index = 0; index < 1000; index += 1) {
      const latitude = random.between(-80, 80);
      const longitude = random.between(-180, 180);
      const length = random.between(1, 1000);
      const azimuth = random.between(0, 360);
      const end = Geodesic.WGS84.Direct(latitude, longitude, azimuth, length);
      const reference = Geodesic.WGS84.Inverse(latitude, longitude, end.lat2 ?? 0, end.lon2 ?? 0).s12 ?? 0;
      worst = Math.max(worst, Math.abs(ellipsoidDistance(latitude, longitude, end.lat2 ?? 0, end.lon2 ?? 0) / reference - 1));
    }
    expect(worst).toBeLessThan(1e-6);
  });

  it("uses the WGS 84 radii of curvature", () => {
    expect(meridianRadius(0)).toBeCloseTo(6_335_439.327, 2);
    expect(parallelRadius(0)).toBeCloseTo(6_378_137, 6);
    expect(meridianRadius(90)).toBeCloseTo(6_399_593.626, 2);
    expect(parallelRadius(45)).toBeCloseTo(4_517_590.879, 2);
  });

  it("wraps the longitude difference across the antimeridian", () => {
    const offset = eastNorthBetween(10, 179.9995, 10, -179.9995);
    expect(offset.east).toBeCloseTo(parallelRadius(10) * 0.001 * (Math.PI / 180), 6);
    expect(offset.north).toBe(0);
    expect(displace(10, 179.9995, offset.east, 0).longitude).toBeCloseTo(-179.9995, 9);
  });

  it("displaces by the inverse of eastNorthBetween", () => {
    const random = createRandom(7);
    for (let index = 0; index < 1000; index += 1) {
      const latitude = random.between(-80, 80);
      const longitude = random.between(-180, 180);
      const east = random.between(-2000, 2000);
      const north = random.between(-2000, 2000);
      const point = displace(latitude, longitude, east, north);
      const back = eastNorthBetween(latitude, longitude, point.latitude, point.longitude);
      expect(Math.abs(back.east - east)).toBeLessThan(1e-6);
      expect(Math.abs(back.north - north)).toBeLessThan(1e-6);
    }
  });

  it("builds an E7 bounding box enclosing every point", () => {
    const builder = new BoundingBoxBuilder();
    expect(builder.build()).toBeNull();
    builder.include(45.12345678, 5.7);
    builder.include(45.2, 5.65432109);
    expect(builder.build()).toEqual({ south: 451_234_567, west: 56_543_210, north: 452_000_000, east: 57_000_000 });
  });
});
