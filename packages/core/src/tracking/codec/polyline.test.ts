import { describe, expect, it } from "vitest";
import { decodePolyline, encodePolyline, PolylineDecodeError } from "./polyline.ts";
import type { CoordinatePath } from "./polyline.ts";

const path = (points: readonly (readonly [number, number])[]): CoordinatePath => ({
  length: points.length,
  latitudeE7: Int32Array.from(points, ([latitude]) => Math.round(latitude * 1e7)),
  longitudeE7: Int32Array.from(points, ([, longitude]) => Math.round(longitude * 1e7)),
});

describe("polyline", () => {
  it("matches the reference example at 5 decimals", () => {
    const reference = path([
      [38.5, -120.2],
      [40.7, -120.95],
      [43.252, -126.453],
    ]);
    const text = encodePolyline(reference, 5);
    expect(text).toBe("_p~iF~ps|U_ulLnnqC_mqNvxq`@");
    expect(decodePolyline(text, 5)).toEqual({ length: 3, latitudeE7: reference.latitudeE7, longitudeE7: reference.longitudeE7 });
  });

  it("round-trips at 6 decimals to the nearest 1e-6 degree", () => {
    const fine = { length: 3, latitudeE7: Int32Array.from([458_326_004, 458_326_015, -899_999_996]), longitudeE7: Int32Array.from([68_652_049, -1_799_999_995, 1_800_000_000]) };
    const decoded = decodePolyline(encodePolyline(fine, 6), 6);
    expect(Array.from(decoded.latitudeE7)).toEqual([458_326_000, 458_326_020, -900_000_000]);
    expect(Array.from(decoded.longitudeE7)).toEqual([68_652_050, -1_800_000_000, 1_800_000_000]);
    expect(encodePolyline(decoded, 6)).toBe(encodePolyline(fine, 6));
  });

  it("rounds halves away from zero, symmetrically", () => {
    const decoded = decodePolyline(encodePolyline({ length: 2, latitudeE7: [150, -150], longitudeE7: [-250, 250] }, 5), 5);
    expect(Array.from(decoded.latitudeE7)).toEqual([200, -200]);
    expect(Array.from(decoded.longitudeE7)).toEqual([-300, 300]);
  });

  it("encodes an empty path as an empty string", () => {
    expect(encodePolyline({ length: 0, latitudeE7: [], longitudeE7: [] }, 5)).toBe("");
    expect(decodePolyline("", 5).length).toBe(0);
  });

  it("rejects foreign characters, unterminated or unpaired values and out-of-bounds coordinates", () => {
    expect(() => decodePolyline("_p~iF ~ps|U", 5)).toThrow(PolylineDecodeError);
    expect(() => decodePolyline("_p~iF~ps|", 5)).toThrow(PolylineDecodeError);
    expect(() => decodePolyline("_p~iF", 5)).toThrow(PolylineDecodeError);
    expect(() => decodePolyline("~~~~~~~?", 5)).toThrow(PolylineDecodeError);
    expect(() => decodePolyline(encodePolyline({ length: 1, latitudeE7: [900_000_000], longitudeE7: [0] }, 6), 5)).toThrow(PolylineDecodeError);
  });
});
