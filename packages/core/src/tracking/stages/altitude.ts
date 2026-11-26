import { fromBase64 } from "../../agent/encoding.ts";
import type { Fix, PressureSample } from "../types.ts";
import { geoidGrid } from "./geoidGrid.ts";

export const defaultVerticalSigma = 15;
export const barometerMedianLength = 5;
export const barometerSmoothingMs = 4000;
/** The offset filter has this time constant at 1 Hz for a GNSS altitude of `offsetReferenceSigma` vertical accuracy. */
export const offsetTimeConstantMs = 300_000;
export const offsetReferenceSigma = 5;
/** Random-walk deviation of the GNSS-only altitude, in meters per square root of second. */
export const gnssAltitudeProcessNoise = 0.3;
export const altitudeAverageMeters = 50;
/** Hysteresis threshold `H` by altitude source (`ELE-010`). */
export const elevationThresholdMeters = { barometer: 2, gnss: 6, dem: 3 } as const;
export const gradeHalfWindowMeters = 10;
export const maxGrade = 0.6;
export const verticalSpeedWindowMs = 30_000;
export const vamMinimumGrade = 0.03;

let geoid: Int16Array | null = null;

function geoidCentimeters(): Int16Array {
  if (geoid !== null) return geoid;
  const bytes = fromBase64(geoidGrid.centimeters);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const values = new Int16Array(bytes.byteLength / 2);
  for (let index = 0; index < values.length; index += 1) values[index] = view.getInt16(index * 2, true);
  geoid = values;
  return values;
}

/** EGM96 undulation in meters, bilinear on the embedded 1 degree grid (`ELE-001`). */
export function geoidUndulation(latitude: number, longitude: number): number {
  const grid = geoidCentimeters();
  const { rows, columns } = geoidGrid;
  const y = Math.min(Math.max(90 - latitude, 0), rows - 1);
  const x = (((longitude % 360) + 360) % 360) * (columns / 360);
  const row = Math.min(Math.floor(y), rows - 2);
  const column = Math.floor(x) % columns;
  const nextColumn = (column + 1) % columns;
  const fy = y - row;
  const fx = x - Math.floor(x);
  const at = (r: number, c: number): number => grid[r * columns + c] ?? 0;
  const top = at(row, column) * (1 - fx) + at(row, nextColumn) * fx;
  const bottom = at(row + 1, column) * (1 - fx) + at(row + 1, nextColumn) * fx;
  return (top * (1 - fy) + bottom * fy) / 100;
}

/** Altitude above mean sea level in meters (`ELE-001`): the platform value when present, else the ellipsoidal height minus the geoid. */
export function orthometricAltitude(fix: Fix): number | null {
  if (fix.altitudeMslMm !== null) return fix.altitudeMslMm / 1000;
  if (fix.altitudeEllipsoidMm === null) return null;
  return fix.altitudeEllipsoidMm / 1000 - geoidUndulation(fix.latitudeE7 / 1e7, fix.longitudeE7 / 1e7);
}

/** Vertical accuracy of a fix in meters. */
export function verticalSigma(fix: Fix): number {
  return fix.verticalAccuracyDm === null || fix.verticalAccuracyDm <= 0 ? defaultVerticalSigma : fix.verticalAccuracyDm / 10;
}

/** Standard-atmosphere altitude of a pressure, in meters: only its variations are used. */
export function pressureAltitude(pascals: number): number {
  return 44_330.77 * (1 - (pascals / 101_325) ** 0.190263);
}

/** t, filtered value, filtered variance, predicted variance. */
const scalarStride = 4;

/**
 * Random-walk scalar Kalman filter: process variance `processNoise` per second, measurement variance from each sigma; with
 * `smoothing`, the steps are kept for a Rauch-Tung-Striebel backward pass.
 */
export class ScalarKalman {
  private readonly processNoise: number;
  private readonly smoothing: boolean;
  private steps = new Float64Array(0);
  private count = 0;
  private estimate = 0;
  private variance = 0;
  private t: number | null = null;

  constructor(processNoise: number, options: { readonly smoothing: boolean }) {
    this.processNoise = processNoise;
    this.smoothing = options.smoothing;
  }

  get value(): number | null {
    return this.t === null ? null : this.estimate;
  }

  push(t: number, measurement: number, sigma: number): number {
    const measurementVariance = sigma * sigma;
    let predictedVariance = measurementVariance;
    if (this.t === null) {
      this.estimate = measurement;
      this.variance = measurementVariance;
    } else {
      predictedVariance = this.variance + (this.processNoise * Math.max(t - this.t, 0)) / 1000;
      const gain = predictedVariance / (predictedVariance + measurementVariance);
      this.estimate += gain * (measurement - this.estimate);
      this.variance = (1 - gain) * predictedVariance;
    }
    this.t = t;
    if (this.smoothing) this.record(t, predictedVariance);
    return this.estimate;
  }

  /** Smoothed value for every pushed measurement, in order. */
  smoothRts(): Float64Array {
    const length = this.count;
    const steps = this.steps;
    const smoothed = new Float64Array(length);
    for (let k = length - 1; k >= 0; k -= 1) {
      const base = k * scalarStride;
      const filtered = steps[base + 1] ?? 0;
      if (k === length - 1) {
        smoothed[k] = filtered;
        continue;
      }
      const gain = (steps[base + 2] ?? 0) / (steps[base + scalarStride + 3] ?? 1);
      smoothed[k] = filtered + gain * ((smoothed[k + 1] ?? 0) - filtered);
    }
    return smoothed;
  }

  private record(t: number, predictedVariance: number): void {
    if ((this.count + 1) * scalarStride > this.steps.length) {
      const steps = new Float64Array(Math.max(this.steps.length * 2, scalarStride * 1024));
      steps.set(this.steps);
      this.steps = steps;
    }
    const base = this.count * scalarStride;
    this.steps[base] = t;
    this.steps[base + 1] = this.estimate;
    this.steps[base + 2] = this.variance;
    this.steps[base + 3] = predictedVariance;
    this.count += 1;
  }
}

/** GNSS-only altitude (`ELE-002`): scalar Kalman filter on the orthometric altitude, smoothed backward in batch mode. */
export function gnssAltitudeFilter(options: { readonly smoothing: boolean }): ScalarKalman {
  return new ScalarKalman(gnssAltitudeProcessNoise ** 2, options);
}

/**
 * Barometer and GNSS fusion (`ELE-002`): `h = h_baro + o`, the barometric altitude smoothed by a 5-sample median and a 4 s
 * exponential average, the offset `o` tracked by a scalar Kalman filter on the gap between the orthometric GNSS altitude and
 * the latest raw barometric altitude, so the smoothing lag on slopes does not leak into the offset.
 */
export class BarometricFusion {
  private readonly recent: number[] = [];
  private readonly offset: ScalarKalman;
  private readonly smoothing: boolean;
  private readonly barometricAtGnss: number[] = [];
  private latest: number | null = null;
  private smoothed: number | null = null;
  private smoothedT = 0;

  /** With `smoothing`, the offset is also smoothed backward for `smoothRts`. */
  constructor(options: { readonly smoothing: boolean }) {
    this.smoothing = options.smoothing;
    this.offset = new ScalarKalman(offsetReferenceSigma ** 2 / (offsetTimeConstantMs / 1000) ** 2, options);
  }

  get barometricAltitude(): number | null {
    return this.smoothed;
  }

  /** `null` until both a pressure and a GNSS altitude have arrived. */
  get altitude(): number | null {
    const offset = this.offset.value;
    return this.smoothed === null || offset === null ? null : this.smoothed + offset;
  }

  pushPressure(sample: PressureSample): void {
    this.latest = pressureAltitude(sample.pascals);
    this.recent.push(this.latest);
    if (this.recent.length > barometerMedianLength) this.recent.shift();
    const sorted = [...this.recent].sort((left, right) => left - right);
    const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
    if (this.smoothed === null) this.smoothed = median;
    else this.smoothed += (median - this.smoothed) * (1 - Math.exp(-Math.max(sample.t - this.smoothedT, 0) / barometerSmoothingMs));
    this.smoothedT = sample.t;
  }

  /** Returns the fused altitude, or `null` when the GNSS altitude arrives before any pressure and is ignored. */
  pushGnss(t: number, altitude: number, sigma: number): number | null {
    if (this.latest === null || this.smoothed === null) return null;
    this.offset.push(t, altitude - this.latest, sigma);
    if (this.smoothing) this.barometricAtGnss.push(this.smoothed);
    return this.altitude;
  }

  /** Fused altitude at every GNSS altitude that was not ignored, in order, with the offset smoothed backward. */
  smoothRts(): Float64Array {
    const offsets = this.offset.smoothRts();
    return offsets.map((offset, index) => offset + (this.barometricAtGnss[index] ?? 0));
  }
}

/** Centered moving average of `values` over `windowMeters` of cumulative horizontal distance, O(n). */
export function distanceMovingAverage(distance: Float64Array, values: Float64Array, windowMeters: number = altitudeAverageMeters): Float64Array {
  const length = values.length;
  const averaged = new Float64Array(length);
  const half = windowMeters / 2;
  let low = 0;
  let high = 0;
  let sum = 0;
  for (let index = 0; index < length; index += 1) {
    const center = distance[index] ?? 0;
    while (high < length && (distance[high] ?? 0) <= center + half) {
      sum += values[high] ?? 0;
      high += 1;
    }
    while ((distance[low] ?? 0) < center - half) {
      sum -= values[low] ?? 0;
      low += 1;
    }
    averaged[index] = sum / (high - low);
  }
  return averaged;
}

/**
 * Ascent and descent by threshold hysteresis (`ELE-010`): a change counts once it exceeds `H` from the last extremum, then in
 * full. Altitude changes over uncounted intervals (stopped, unfilled gaps) are removed before the automaton.
 */
export class ElevationHysteresis {
  private readonly threshold: number;
  private previous: number | null = null;
  private level = 0;
  private turn = 0;
  private direction: "up" | "down" | null = null;
  ascent = 0;
  descent = 0;

  constructor(threshold: number) {
    this.threshold = threshold;
  }

  /** Last extremum on the counted altitude scale, which starts at the first altitude. */
  get extremum(): number {
    return this.turn;
  }

  push(altitude: number, counted: boolean): void {
    if (this.previous === null) {
      this.previous = altitude;
      this.level = altitude;
      this.turn = altitude;
      return;
    }
    if (counted) this.level += altitude - this.previous;
    this.previous = altitude;
    const h = this.level;
    switch (this.direction) {
      case "up":
        if (h > this.turn) this.climb(h);
        else if (this.turn - h >= this.threshold) this.drop(h);
        break;
      case "down":
        if (h < this.turn) this.drop(h);
        else if (h - this.turn >= this.threshold) this.climb(h);
        break;
      case null:
        if (h - this.turn >= this.threshold) this.climb(h);
        else if (this.turn - h >= this.threshold) this.drop(h);
        break;
      default: {
        const unreachable: never = this.direction;
        throw new Error(`Unhandled direction ${String(unreachable)}`);
      }
    }
  }

  private climb(h: number): void {
    this.ascent += h - this.turn;
    this.turn = h;
    this.direction = "up";
  }

  private drop(h: number): void {
    this.descent += this.turn - h;
    this.turn = h;
    this.direction = "down";
  }
}

function clampGrade(grade: number): number {
  return Math.min(Math.max(grade, -maxGrade), maxGrade);
}

/**
 * Grade `(h(s + D) - h(s - D)) / 2D` over cumulative distance (`ELE-020`), altitudes interpolated linearly; `NaN` where the
 * window leaves the track or the interval ending at the sample is not moving (1 in `moving`).
 */
export function gradeSeries(distance: Float64Array, altitude: Float64Array, moving: Uint8Array): Float64Array {
  const length = altitude.length;
  const grades = new Float64Array(length).fill(Number.NaN);
  if (length === 0) return grades;
  const first = distance[0] ?? 0;
  const last = distance[length - 1] ?? 0;
  const halfWindow = gradeHalfWindowMeters;
  let behind = 0;
  let ahead = 0;
  const interpolate = (index: number, target: number): number => {
    if (index === 0) return altitude[0] ?? 0;
    const lowDistance = distance[index - 1] ?? 0;
    const highDistance = distance[index] ?? 0;
    const lowAltitude = altitude[index - 1] ?? 0;
    const highAltitude = altitude[index] ?? 0;
    return highDistance === lowDistance ? highAltitude : lowAltitude + ((target - lowDistance) / (highDistance - lowDistance)) * (highAltitude - lowAltitude);
  };
  for (let index = 0; index < length; index += 1) {
    const center = distance[index] ?? 0;
    if (moving[index] !== 1 || center - halfWindow < first || center + halfWindow > last) continue;
    while ((distance[behind] ?? 0) < center - halfWindow) behind += 1;
    while ((distance[ahead] ?? 0) < center + halfWindow) ahead += 1;
    grades[index] = clampGrade((interpolate(ahead, center + halfWindow) - interpolate(behind, center - halfWindow)) / (2 * halfWindow));
  }
  return grades;
}

/** Live grade over the trailing 2 D meters: the `gradeSeries` value of the point D meters back. */
export class GradeMeter {
  private distances: number[] = [];
  private altitudes: number[] = [];
  private head = 0;

  push(distance: number, altitude: number): number | null {
    this.distances.push(distance);
    this.altitudes.push(altitude);
    const target = distance - 2 * gradeHalfWindowMeters;
    while (this.head + 1 < this.distances.length && (this.distances[this.head + 1] ?? 0) <= target) this.head += 1;
    this.compact();
    const baseDistance = this.distances[this.head] ?? 0;
    if (baseDistance > target) return null;
    const nextDistance = this.distances[this.head + 1] ?? baseDistance;
    const baseAltitude = this.altitudes[this.head] ?? 0;
    const nextAltitude = this.altitudes[this.head + 1] ?? baseAltitude;
    const behind = nextDistance === baseDistance ? baseAltitude : baseAltitude + ((target - baseDistance) / (nextDistance - baseDistance)) * (nextAltitude - baseAltitude);
    return clampGrade((altitude - behind) / (2 * gradeHalfWindowMeters));
  }

  private compact(): void {
    if (this.head < 64 || this.head * 2 < this.distances.length) return;
    this.distances = this.distances.slice(this.head);
    this.altitudes = this.altitudes.slice(this.head);
    this.head = 0;
  }
}

/** Derivative of the smoothed altitude over a trailing window, in m/s (`ELE-021`); `null` until half a window of history. */
export class VerticalSpeedMeter {
  private readonly windowMs: number;
  private times: number[] = [];
  private altitudes: number[] = [];
  private head = 0;

  constructor(windowMs: number = verticalSpeedWindowMs) {
    this.windowMs = windowMs;
  }

  push(t: number, altitude: number): number | null {
    this.times.push(t);
    this.altitudes.push(altitude);
    const target = t - this.windowMs;
    while (this.head + 1 < this.times.length && (this.times[this.head + 1] ?? 0) <= target) this.head += 1;
    if (this.head >= 64 && this.head * 2 >= this.times.length) {
      this.times = this.times.slice(this.head);
      this.altitudes = this.altitudes.slice(this.head);
      this.head = 0;
    }
    const baseTime = this.times[this.head] ?? t;
    if (t - baseTime < this.windowMs / 2) return null;
    if (baseTime >= target) return ((altitude - (this.altitudes[this.head] ?? 0)) * 1000) / (t - baseTime);
    const nextTime = this.times[this.head + 1] ?? baseTime;
    const baseAltitude = this.altitudes[this.head] ?? 0;
    const nextAltitude = this.altitudes[this.head + 1] ?? baseAltitude;
    const behind = baseAltitude + ((target - baseTime) / (nextTime - baseTime)) * (nextAltitude - baseAltitude);
    return ((altitude - behind) * 1000) / this.windowMs;
  }
}

/** VAM (`ELE-021`): climb of the moving intervals steeper than 3 % over their duration, in m/h. */
export class VamMeter {
  private climbed = 0;
  private durationMs = 0;

  push(durationMs: number, climb: number, grade: number, moving: boolean): void {
    if (!moving || !(grade > vamMinimumGrade)) return;
    this.climbed += Math.max(climb, 0);
    this.durationMs += durationMs;
  }

  get value(): number | null {
    return this.durationMs === 0 ? null : (this.climbed * 3_600_000) / this.durationMs;
  }
}
