import { describe, expect, it } from "vitest";
import { displace, ellipsoidDistance } from "./geo.ts";
import { effectiveRadiusMeters, maskTrack } from "./privacy.ts";
import type { MaskZone, TrackPositions } from "./privacy.ts";
import type { PrivacyMask } from "./privacyZones.ts";
import { shareTrack, shareTrackRuns } from "./shareImage.ts";
import { previewMaxPoints } from "./simplify.ts";
import { origin } from "./testing/fixes.ts";

/** Points every `step` meters along straight legs from `origin`, with a small zigzag so simplification keeps some. */
function polyline(corners: readonly (readonly [number, number])[], step = 5): TrackPositions {
  const latitude: number[] = [];
  const longitude: number[] = [];
  const push = (east: number, north: number): void => {
    const point = displace(origin.latitude, origin.longitude, east, north);
    latitude.push(point.latitude);
    longitude.push(point.longitude);
  };
  const [first] = corners;
  if (first !== undefined) push(first[0], first[1]);
  for (let index = 1; index < corners.length; index += 1) {
    const [fromEast, fromNorth] = corners[index - 1] ?? [0, 0];
    const [toEast, toNorth] = corners[index] ?? [0, 0];
    const count = Math.max(1, Math.round(Math.hypot(toEast - fromEast, toNorth - fromNorth) / step));
    for (let k = 1; k <= count; k += 1) push(fromEast + ((toEast - fromEast) * k) / count, fromNorth + ((toNorth - fromNorth) * k) / count + (k % 40 < 20 ? 0 : 12));
  }
  return { length: latitude.length, latitude: Float64Array.from(latitude), longitude: Float64Array.from(longitude) };
}

function zoneAt(east: number, north: number, radiusMeters: number, maskScalePermille: number): MaskZone {
  const center = displace(origin.latitude, origin.longitude, east, north);
  return { latitudeE7: Math.round(center.latitude * 1e7), longitudeE7: Math.round(center.longitude * 1e7), radiusMeters, maskScalePermille };
}

const frame = { width: 900, height: 700 };

describe("shareTrack", () => {
  it("draws only points the mask keeps, one line per visible run (SUM-006, PRV-010, PRV-012)", () => {
    const zone = zoneAt(1500, 0, 200, 1200);
    const mask: PrivacyMask = { zones: [zone], hideEndsMeters: 300 };
    const track = polyline([
      [0, 0],
      [3000, 0],
      [3000, 1500],
    ]);
    const masked = maskTrack(track, mask.zones, mask);
    const runs = shareTrackRuns(track, mask);
    expect(runs).toHaveLength(2);
    for (const run of runs) {
      for (const index of run) {
        expect(masked.hidden[index]).toBe(0);
        const gap = ellipsoidDistance(zone.latitudeE7 / 1e7, zone.longitudeE7 / 1e7, track.latitude[index] ?? 0, track.longitude[index] ?? 0);
        expect(gap).toBeGreaterThanOrEqual(effectiveRadiusMeters(zone));
      }
    }
    const visibleRuns = masked.visible.filter((range) => range.end - range.start >= 2);
    runs.forEach((run, position) => {
      const range = visibleRuns[position];
      expect(run[0]).toBe(range?.start);
      expect(run[run.length - 1]).toBe((range?.end ?? 0) - 1);
    });
    expect(runs[0]?.[0]).toBeGreaterThan(0);
    expect(runs.reduce((total, run) => total + run.length, 0)).toBeLessThanOrEqual(previewMaxPoints);
  });

  it("fits the visible points in the frame, in proportion and centered", () => {
    const mask: PrivacyMask = { zones: [], hideEndsMeters: 0 };
    const track = polyline([
      [0, 0],
      [2000, 0],
      [2000, 1000],
    ]);
    const drawn = shareTrack(track, mask, frame);
    if (drawn === null) throw new Error("Nothing drawn");
    const points = drawn.runs.flat();
    const xs = points.map((point) => point.x);
    const ys = points.map((point) => point.y);
    expect(Math.min(...xs)).toBeCloseTo(0, 6);
    expect(Math.max(...xs)).toBeCloseTo(frame.width, 6);
    expect(Math.min(...ys) + Math.max(...ys)).toBeCloseTo(frame.height, 6);
    expect((Math.max(...ys) - Math.min(...ys)) / (Math.max(...xs) - Math.min(...xs))).toBeCloseTo(1012 / 2000, 2);
    expect(drawn.start).toEqual(points[0]);
    expect(drawn.end.x).toBeCloseTo(frame.width, 1);
    expect(drawn.end.y).toBeLessThan(drawn.start.y);
  });

  it("draws nothing when the mask hides the whole track", () => {
    const track = polyline([
      [0, 0],
      [400, 0],
    ]);
    expect(shareTrack(track, { zones: [zoneAt(200, 0, 500, 1000)], hideEndsMeters: 0 }, frame)).toBeNull();
    expect(shareTrack(track, { zones: [], hideEndsMeters: 250 }, frame)).toBeNull();
    expect(shareTrack({ length: 0, latitude: new Float64Array(0), longitude: new Float64Array(0) }, { zones: [], hideEndsMeters: 0 }, frame)).toBeNull();
  });
});
