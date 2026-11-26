import { processTrack, resolveProfile, toSampleColumns } from "@obnixe/core";
import type { Fix, ProcessedTrack, Sample } from "@obnixe/core";
import type { EpochMs } from "@obnixe/schema";

const origin = { latitude: 45.2, longitude: 5.7 };
const metersPerDegree = 111_320;

function fixAt(t: number, north: number, east: number, altitudeMeters: number): Fix {
  return {
    type: "fix",
    t,
    fixAgeMs: 0,
    latitudeE7: Math.round((origin.latitude + north / metersPerDegree) * 1e7),
    longitudeE7: Math.round((origin.longitude + east / (metersPerDegree * Math.cos((origin.latitude * Math.PI) / 180))) * 1e7),
    altitudeEllipsoidMm: Math.round(altitudeMeters * 1000),
    altitudeMslMm: null,
    horizontalAccuracyDm: 40,
    verticalAccuracyDm: 60,
    speedCmS: 300,
    speedAccuracyCmS: 50,
    bearingCentiDeg: null,
    bearingAccuracyCentiDeg: null,
    simulated: false,
  };
}

/** A run at 3 m/s heading east with a gentle north swing and a rolling profile, one fix per second, processed as recorded. */
export function processedRun(seconds: number): ProcessedTrack {
  const samples: Sample[] = [];
  for (let second = 1; second <= seconds; second += 1) {
    const east = second * 3;
    samples.push(fixAt(second * 1000, Math.sin(east / 400) * 150, east, 300 + Math.sin(east / 900) * 40));
  }
  const profile = resolveProfile("run", {});
  if (profile === null) throw new Error("run records no track");
  const track = { startedAt: Date.UTC(2026, 10, 20, 8, 0) as EpochMs, samples: toSampleColumns(samples), marks: [{ kind: "start" as const, t: 0 }, { kind: "stop" as const, t: seconds * 1000 }] };
  return processTrack(track, profile, { laps: { kind: "recorded", autoLap: null }, trim: { startMs: 0, endMs: null } });
}
