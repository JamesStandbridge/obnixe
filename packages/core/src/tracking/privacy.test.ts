import { describe, expect, it } from "vitest";
import { displace, ellipsoidDistance } from "./geo.ts";
import { drawMaskScalePermille, effectiveRadiusMeters, maskScaleBounds, maskTrack } from "./privacy.ts";
import type { MaskZone, TrackPositions } from "./privacy.ts";
import { origin } from "./testing/fixes.ts";
import { createRandom } from "./testing/random.ts";

/** Points every `step` meters along straight legs from `origin`, given as east-north offsets of their ends. */
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
    for (let k = 1; k <= count; k += 1) push(fromEast + ((toEast - fromEast) * k) / count, fromNorth + ((toNorth - fromNorth) * k) / count);
  }
  return { length: latitude.length, latitude: Float64Array.from(latitude), longitude: Float64Array.from(longitude) };
}

function zoneAt(east: number, north: number, radiusMeters: number, maskScalePermille: number): MaskZone {
  const center = displace(origin.latitude, origin.longitude, east, north);
  return { latitudeE7: Math.round(center.latitude * 1e7), longitudeE7: Math.round(center.longitude * 1e7), radiusMeters, maskScalePermille };
}

function distanceToZone(track: TrackPositions, index: number, zone: MaskZone): number {
  return ellipsoidDistance(zone.latitudeE7 / 1e7, zone.longitudeE7 / 1e7, track.latitude[index] ?? 0, track.longitude[index] ?? 0);
}

function along(track: TrackPositions, from: number, to: number): number {
  let total = 0;
  for (let index = from + 1; index <= to; index += 1) total += ellipsoidDistance(track.latitude[index - 1] ?? 0, track.longitude[index - 1] ?? 0, track.latitude[index] ?? 0, track.longitude[index] ?? 0);
  return total;
}

const noEnds = { hideEndsMeters: 0 };

describe("maskTrack", () => {
  it("shows the whole track as one line without zones nor hidden ends", () => {
    const track = polyline([
      [0, 0],
      [1000, 0],
    ]);
    const masked = maskTrack(track, [], noEnds);
    expect(masked.visible).toEqual([{ start: 0, end: track.length }]);
    expect(maskTrack({ length: 0, latitude: new Float64Array(0), longitude: new Float64Array(0) }, [], noEnds)).toEqual({ hidden: new Uint8Array(0), visible: [] });
  });

  it("hides the start of a track leaving home up to the effective radius along the track (PRV-010, PRV-012)", () => {
    const zone = zoneAt(0, 0, 200, 1150);
    const radius = effectiveRadiusMeters(zone);
    expect(radius).toBe(230);
    const track = polyline([
      [0, 0],
      [2000, 0],
    ]);
    const masked = maskTrack(track, [zone], noEnds);
    const [first] = masked.visible;
    expect(masked.visible).toHaveLength(1);
    expect(first?.end).toBe(track.length);
    expect(along(track, 0, first?.start ?? 0)).toBeGreaterThan(radius);
    expect(along(track, 0, (first?.start ?? 0) - 1)).toBeLessThanOrEqual(radius);
  });

  it("hides a grazing pass along the track on both sides of its closest point, splitting the line", () => {
    const zone = zoneAt(1000, 150, 200, 1000);
    const track = polyline([
      [0, 0],
      [2000, 0],
    ]);
    const masked = maskTrack(track, [zone], noEnds);
    expect(masked.visible).toHaveLength(2);
    const [before, after] = masked.visible;
    const closest = 200;
    expect(along(track, (before?.end ?? 0) - 1, closest)).toBeGreaterThan(200);
    expect(along(track, closest, after?.start ?? 0)).toBeGreaterThan(200);
    expect(distanceToZone(track, (before?.end ?? 0) - 1, zone)).toBeGreaterThan(250);
  });

  it("hides the first and last meters of every track", () => {
    const track = polyline([
      [0, 0],
      [1000, 0],
    ]);
    const masked = maskTrack(track, [], { hideEndsMeters: 102 });
    expect(masked.visible).toEqual([{ start: 21, end: track.length - 21 }]);
    expect(maskTrack(track, [], { hideEndsMeters: 600 }).visible).toEqual([]);
  });

  it("never shows a point inside an effective radius and leaves the track untouched (PRV-012, PRV-013)", () => {
    const random = createRandom(12);
    for (let trial = 0; trial < 1000; trial += 1) {
      const corners: [number, number][] = [[random.between(-1500, 1500), random.between(-1500, 1500)]];
      for (let leg = 0; leg < 6; leg += 1) corners.push([random.between(-1500, 1500), random.between(-1500, 1500)]);
      const track = polyline(corners, random.between(2, 25));
      const zones = Array.from({ length: 1 + Math.floor(random.uniform() * 3) }, () =>
        zoneAt(random.between(-1000, 1000), random.between(-1000, 1000), Math.round(random.between(100, 600)), drawMaskScalePermille(random.uniform)),
      );
      const latitude = track.latitude.slice();
      const masked = maskTrack(track, zones, { hideEndsMeters: Math.round(random.between(0, 300)) });
      expect(track.latitude).toEqual(latitude);
      let exposed = 0;
      for (const range of masked.visible) {
        for (let index = range.start; index < range.end; index += 1) {
          if (masked.hidden[index] !== 0) exposed += 1;
          for (const zone of zones) if (distanceToZone(track, index, zone) < effectiveRadiusMeters(zone)) exposed += 1;
        }
      }
      expect(exposed).toBe(0);
      expect(masked.visible.reduce((total, range) => total + range.end - range.start, 0)).toBe(masked.hidden.filter((value) => value === 0).length);
    }
  });
});

describe("drawMaskScalePermille", () => {
  it("draws between r and 1.3 r", () => {
    expect(drawMaskScalePermille(() => 0)).toBe(maskScaleBounds.minPermille);
    expect(drawMaskScalePermille(() => 0.999_999)).toBe(maskScaleBounds.maxPermille);
    const random = createRandom(3);
    for (let index = 0; index < 1000; index += 1) {
      const value = drawMaskScalePermille(random.uniform);
      expect(Number.isInteger(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(1000);
      expect(value).toBeLessThanOrEqual(1300);
    }
  });
});
