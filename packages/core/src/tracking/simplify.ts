import { encodePolyline } from "./codec/polyline.ts";
import { meridianRadius, parallelRadius } from "./geo.ts";
import type { MaskedTrack, TrackPositions } from "./privacy.ts";

export const previewToleranceMeters = 5;
export const previewMaxPoints = 500;

const radiansPerDegree = Math.PI / 180;

function squaredSegmentDistance(x: Float64Array, y: Float64Array, point: number, from: number, to: number): number {
  const ax = x[from] ?? 0;
  const ay = y[from] ?? 0;
  const dx = (x[to] ?? 0) - ax;
  const dy = (y[to] ?? 0) - ay;
  const px = (x[point] ?? 0) - ax;
  const py = (y[point] ?? 0) - ay;
  const length = dx * dx + dy * dy;
  const along = length === 0 ? 0 : Math.min(Math.max((px * dx + py * dy) / length, 0), 1);
  const ex = px - along * dx;
  const ey = py - along * dy;
  return ex * ex + ey * ey;
}

/**
 * Douglas-Peucker significance of every point, in meters: a point is kept at tolerance `e` exactly when its significance
 * exceeds `e`, so any tolerance or point budget is answered without running the recursion again. The ends are infinite.
 * Points are projected once on the plane tangent at the mean latitude, which is precise enough for display (`GPS-070`).
 */
export function douglasPeuckerSignificance(latitude: ArrayLike<number>, longitude: ArrayLike<number>): Float64Array {
  const length = latitude.length;
  const significance = new Float64Array(length);
  if (length === 0) return significance;
  let meanLatitude = 0;
  for (let index = 0; index < length; index += 1) meanLatitude += latitude[index] ?? 0;
  meanLatitude /= length;
  const north = meridianRadius(meanLatitude) * radiansPerDegree;
  const east = parallelRadius(meanLatitude) * radiansPerDegree;
  const reference = longitude[0] ?? 0;
  const x = new Float64Array(length);
  const y = new Float64Array(length);
  for (let index = 0; index < length; index += 1) {
    const delta = (longitude[index] ?? 0) - reference;
    x[index] = east * (delta > 180 ? delta - 360 : delta < -180 ? delta + 360 : delta);
    y[index] = north * (latitude[index] ?? 0);
  }
  significance[0] = Number.POSITIVE_INFINITY;
  significance[length - 1] = Number.POSITIVE_INFINITY;
  const stack: number[] = [0, length - 1, Number.POSITIVE_INFINITY];
  while (stack.length > 0) {
    const cap = stack.pop() ?? 0;
    const to = stack.pop() ?? 0;
    const from = stack.pop() ?? 0;
    let farthest = -1;
    let worst = -1;
    for (let index = from + 1; index < to; index += 1) {
      const distance = squaredSegmentDistance(x, y, index, from, to);
      if (distance > worst) {
        worst = distance;
        farthest = index;
      }
    }
    if (farthest < 0) continue;
    const value = Math.min(Math.sqrt(worst), cap);
    significance[farthest] = value;
    stack.push(from, farthest, value, farthest, to, value);
  }
  return significance;
}

/** Indices kept by Douglas-Peucker at `toleranceMeters`, then raising the tolerance until at most `maxPoints` remain (display only, `GPS-070`). */
export function simplifyPath(latitude: ArrayLike<number>, longitude: ArrayLike<number>, toleranceMeters: number, maxPoints: number = Number.POSITIVE_INFINITY): Uint32Array {
  const significance = douglasPeuckerSignificance(latitude, longitude);
  let threshold = toleranceMeters;
  if (significance.length > maxPoints) {
    const sorted = Float64Array.from(significance).sort();
    threshold = Math.max(threshold, sorted[sorted.length - Math.max(maxPoints, 2) - 1] ?? 0);
  }
  let count = 0;
  for (const value of significance) if (value > threshold) count += 1;
  const kept = new Uint32Array(count);
  let next = 0;
  for (let index = 0; index < significance.length; index += 1) if ((significance[index] ?? 0) > threshold) kept[next++] = index;
  return kept;
}

/**
 * The stored preview (`recording.preview_polyline`): the visible points of the masked track (`PRV-010`), at 5 m tolerance and at
 * most 500 points, polyline precision 5; `null` when nothing is visible. Visible runs are joined end to end: a hidden part
 * becomes a straight chord that carries none of its points.
 */
export function previewPolyline(track: TrackPositions, masked: MaskedTrack): string | null {
  let count = 0;
  for (const range of masked.visible) count += range.end - range.start;
  if (count === 0) return null;
  const latitude = new Float64Array(count);
  const longitude = new Float64Array(count);
  let next = 0;
  for (const { start, end } of masked.visible) {
    latitude.set(track.latitude.subarray(start, end), next);
    longitude.set(track.longitude.subarray(start, end), next);
    next += end - start;
  }
  const kept = simplifyPath(latitude, longitude, previewToleranceMeters, previewMaxPoints);
  const latitudeE7 = new Int32Array(kept.length);
  const longitudeE7 = new Int32Array(kept.length);
  kept.forEach((index, position) => {
    latitudeE7[position] = Math.round((latitude[index] ?? 0) * 1e7);
    longitudeE7[position] = Math.round((longitude[index] ?? 0) * 1e7);
  });
  return encodePolyline({ length: kept.length, latitudeE7, longitudeE7 }, 5);
}

/**
 * Largest Triangle Three Buckets (`SUM-002`, `INT-041`): indices of at most `threshold` points that keep the visible extremes
 * of `y` over `x`. Both series must be finite; the first and last points are always kept.
 */
export function lttb(x: ArrayLike<number>, y: ArrayLike<number>, threshold: number): Uint32Array {
  const length = x.length;
  if (threshold >= length || length <= 2) return Uint32Array.from({ length }, (_, index) => index);
  if (threshold < 3) return Uint32Array.of(0, length - 1);
  const kept = new Uint32Array(threshold);
  const bucket = (length - 2) / (threshold - 2);
  let selected = 0;
  for (let index = 0; index < threshold - 2; index += 1) {
    const start = Math.floor(index * bucket) + 1;
    const end = Math.floor((index + 1) * bucket) + 1;
    const nextEnd = Math.min(Math.floor((index + 2) * bucket) + 1, length);
    let averageX = 0;
    let averageY = 0;
    for (let next = end; next < nextEnd; next += 1) {
      averageX += x[next] ?? 0;
      averageY += y[next] ?? 0;
    }
    const nextCount = nextEnd - end;
    averageX /= nextCount;
    averageY /= nextCount;
    const ax = x[selected] ?? 0;
    const ay = y[selected] ?? 0;
    let best = start;
    let largest = -1;
    for (let candidate = start; candidate < end; candidate += 1) {
      const area = Math.abs((ax - averageX) * ((y[candidate] ?? 0) - ay) - (ax - (x[candidate] ?? 0)) * (averageY - ay));
      if (area > largest) {
        largest = area;
        best = candidate;
      }
    }
    kept[index + 1] = best;
    selected = best;
  }
  kept[threshold - 1] = length - 1;
  return kept;
}
