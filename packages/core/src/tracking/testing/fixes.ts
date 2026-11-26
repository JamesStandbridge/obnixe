import { displace } from "../geo.ts";
import type { GeoPoint } from "../geo.ts";
import { toSampleColumns } from "../types.ts";
import type { Fix, HeartRateColumns, HeartRateSample } from "../types.ts";

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

/** Heart-rate columns from `[t, bpm]` readings, a 0 bpm reading standing for a lost skin contact. */
export function heartRateColumns(readings: readonly (readonly [number, number])[]): HeartRateColumns {
  const samples = readings.map(([t, bpm]): HeartRateSample => ({ type: "heart_rate", t, bpm, contact: bpm === 0 ? "absent" : "contact", rrInterval: null }));
  return toSampleColumns(samples).heartRate;
}
