import { describe, expect, it } from "vitest";
import { decodePolyline } from "./codec/polyline.ts";
import { displace, meridianRadius, parallelRadius } from "./geo.ts";
import { douglasPeuckerSignificance, lttb, previewMaxPoints, previewPolyline, simplifyPath } from "./simplify.ts";
import { origin } from "./testing/fixes.ts";
import { createRandom } from "./testing/random.ts";

interface Path {
  readonly latitude: Float64Array;
  readonly longitude: Float64Array;
}

function randomWalk(seed: number, length: number, stepMeters: number): Path {
  const random = createRandom(seed);
  const latitude = new Float64Array(length);
  const longitude = new Float64Array(length);
  let east = 0;
  let north = 0;
  let heading = 0;
  for (let index = 0; index < length; index += 1) {
    const point = displace(origin.latitude, origin.longitude, east, north);
    latitude[index] = point.latitude;
    longitude[index] = point.longitude;
    heading += random.gaussian() * 0.6;
    east += stepMeters * Math.sin(heading);
    north += stepMeters * Math.cos(heading);
  }
  return { latitude, longitude };
}

/** The textbook recursion on the same tangent-plane projection. */
function referenceDouglasPeucker(path: Path, tolerance: number): number[] {
  const length = path.latitude.length;
  const mean = path.latitude.reduce((total, value) => total + value, 0) / length;
  const x = Array.from(path.longitude, (value) => ((value - (path.longitude[0] ?? 0)) * parallelRadius(mean) * Math.PI) / 180);
  const y = Array.from(path.latitude, (value) => (value * meridianRadius(mean) * Math.PI) / 180);
  const kept = new Set<number>([0, length - 1]);
  const recurse = (from: number, to: number): void => {
    let farthest = -1;
    let worst = 0;
    for (let index = from + 1; index < to; index += 1) {
      const dx = (x[to] ?? 0) - (x[from] ?? 0);
      const dy = (y[to] ?? 0) - (y[from] ?? 0);
      const along = Math.min(Math.max((((x[index] ?? 0) - (x[from] ?? 0)) * dx + ((y[index] ?? 0) - (y[from] ?? 0)) * dy) / (dx * dx + dy * dy), 0), 1);
      const distance = Math.hypot((x[index] ?? 0) - (x[from] ?? 0) - along * dx, (y[index] ?? 0) - (y[from] ?? 0) - along * dy);
      if (distance > worst) {
        worst = distance;
        farthest = index;
      }
    }
    if (farthest < 0 || worst <= tolerance) return;
    kept.add(farthest);
    recurse(from, farthest);
    recurse(farthest, to);
  };
  recurse(0, length - 1);
  return [...kept].sort((left, right) => left - right);
}

describe("Douglas-Peucker (GPS-070)", () => {
  it("keeps exactly the points of the recursive algorithm at any tolerance", () => {
    for (const seed of [1, 2, 3]) {
      const path = randomWalk(seed, 400, 15);
      for (const tolerance of [1, 5, 20, 80]) expect([...simplifyPath(path.latitude, path.longitude, tolerance)], `seed ${seed} at ${tolerance} m`).toEqual(referenceDouglasPeucker(path, tolerance));
    }
  });

  it("raises the tolerance to honor a point budget, ends included", () => {
    const path = randomWalk(4, 5000, 10);
    const kept = simplifyPath(path.latitude, path.longitude, 0, 120);
    expect(kept.length).toBeLessThanOrEqual(120);
    expect(kept.length).toBeGreaterThan(100);
    expect(kept[0]).toBe(0);
    expect(kept.at(-1)).toBe(4999);
    expect(douglasPeuckerSignificance(path.latitude, path.longitude)[0]).toBe(Infinity);
  });

  it("encodes the visible points of the preview in at most 500 points of precision 5, or nothing (PRV-010)", () => {
    const path = randomWalk(5, 20_000, 8);
    const track = { length: 20_000, ...path };
    const hidden = new Uint8Array(20_000);
    hidden.fill(1, 0, 300);
    hidden.fill(1, 9000, 9500);
    hidden.fill(1, 19_800);
    const preview = previewPolyline(track, { hidden, visible: [{ start: 300, end: 9000 }, { start: 9500, end: 19_800 }] });
    const decoded = decodePolyline(preview ?? "", 5);
    expect(decoded.length).toBeLessThanOrEqual(previewMaxPoints);
    expect(decoded.length).toBeGreaterThan(400);
    expect((decoded.latitudeE7[0] ?? 0) / 1e7).toBeCloseTo(path.latitude[300] ?? 0, 5);
    expect((decoded.longitudeE7.at(-1) ?? 0) / 1e7).toBeCloseTo(path.longitude[19_799] ?? 0, 5);
    const visible = new Set<string>();
    const e5 = (degrees: number): number => Math.round(Math.round(degrees * 1e7) / 100);
    for (let index = 0; index < 20_000; index += 1) if (hidden[index] === 0) visible.add(`${e5(path.latitude[index] ?? 0)},${e5(path.longitude[index] ?? 0)}`);
    for (let index = 0; index < decoded.length; index += 1) {
      expect(visible.has(`${Math.round((decoded.latitudeE7[index] ?? 0) / 100)},${Math.round((decoded.longitudeE7[index] ?? 0) / 100)}`)).toBe(true);
    }
    expect(previewPolyline(track, { hidden: new Uint8Array(20_000).fill(1), visible: [] })).toBeNull();
  });
});

describe("LTTB (SUM-002, INT-041)", () => {
  it("returns increasing indices with both ends and keeps an isolated extreme", () => {
    const length = 10_000;
    const x = Float64Array.from({ length }, (_, index) => index);
    const y = Float64Array.from({ length }, (_, index) => Math.sin(index / 300) + (index === 6543 ? 25 : 0));
    const kept = lttb(x, y, 1000);
    expect(kept).toHaveLength(1000);
    expect(kept[0]).toBe(0);
    expect(kept.at(-1)).toBe(length - 1);
    expect(kept.every((index, position) => position === 0 || index > (kept[position - 1] ?? 0))).toBe(true);
    expect(kept.includes(6543)).toBe(true);
  });

  it("keeps every point under the threshold", () => {
    expect([...lttb([0, 1, 2], [3, 1, 2], 1000)]).toEqual([0, 1, 2]);
    expect([...lttb([0, 1, 2, 3], [3, 1, 2, 0], 2)]).toEqual([0, 3]);
  });
});
