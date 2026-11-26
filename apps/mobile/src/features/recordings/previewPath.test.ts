import { describe, expect, it } from "vitest";
import { encodePolyline } from "@obnixe/core";
import { previewGeometry } from "@/features/recordings/previewPath";

function polylineOf(points: readonly { readonly latitude: number; readonly longitude: number }[]): string {
  return encodePolyline({ length: points.length, latitudeE7: points.map((point) => point.latitude * 1e7), longitudeE7: points.map((point) => point.longitude * 1e7) }, 5);
}

describe("list previews (MAP-023, SUM-010)", () => {
  it("fits the path in its box, centered and in proportion", () => {
    const polyline = polylineOf([
      { latitude: 45, longitude: 5 },
      { latitude: 45.01, longitude: 5 },
    ]);
    const geometry = previewGeometry(polyline, 80, 40, 4);
    expect(geometry?.start.x).toBeCloseTo(40, 2);
    expect(geometry?.start.y).toBe(36);
    expect(geometry?.end.y).toBe(4);
    expect(geometry?.path).toBe("M40.0,36.0L40.0,4.0");
  });

  it("keeps east-west distances true at the latitude of the track", () => {
    const geometry = previewGeometry(
      polylineOf([
        { latitude: 60, longitude: 10 },
        { latitude: 60, longitude: 10.02 },
        { latitude: 60.01, longitude: 10.02 },
      ]),
      100,
      100,
      0,
    );
    const width = (geometry?.end.x ?? 0) - (geometry?.start.x ?? 0);
    const height = (geometry?.start.y ?? 0) - (geometry?.end.y ?? 0);
    expect(width / height).toBeCloseTo(1, 1);
  });

  it("draws nothing for a damaged or a single-point preview", () => {
    expect(previewGeometry("~", 80, 40, 4)).toBeNull();
    expect(previewGeometry(polylineOf([{ latitude: 45, longitude: 5 }]), 80, 40, 4)).toBeNull();
  });
});
