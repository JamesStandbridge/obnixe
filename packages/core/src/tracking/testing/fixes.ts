import { displace } from "../geo.ts";
import type { GeoPoint } from "../geo.ts";
import type { Fix } from "../types.ts";

export const origin: GeoPoint = { latitude: 45.1885, longitude: 5.7245 };

/** A fresh fix `east` and `north` meters from `origin`, 5 m accurate, without altitude nor Doppler data unless overridden. */
export function fixAt(t: number, east: number, north: number, overrides: Partial<Fix> = {}): Fix {
  const position = displace(origin.latitude, origin.longitude, east, north);
  return {
    type: "fix",
    t,
    fixAgeMs: 0,
    latitudeE7: Math.round(position.latitude * 1e7),
    longitudeE7: Math.round(position.longitude * 1e7),
    altitudeEllipsoidMm: null,
    altitudeMslMm: null,
    horizontalAccuracyDm: 50,
    verticalAccuracyDm: null,
    speedCmS: null,
    speedAccuracyCmS: null,
    bearingCentiDeg: null,
    bearingAccuracyCentiDeg: null,
    simulated: false,
    ...overrides,
  };
}
