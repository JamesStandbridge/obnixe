import type { RecordingProfile } from "@obnixe/schema";
import { displace, eastNorthBetween } from "../geo.ts";
import type { Fix } from "../types.ts";

export const minimumPositionSigma = 3;
export const minimumSpeedSigma = 0.3;
export const defaultSpeedSigma = 0.5;
/** Chi-square quantile for 2 degrees of freedom at 0.999: the innovation gate (rule 4). */
export const innovationGate = 13.82;

const radiansPerCentiDegree = Math.PI / 18_000;

export interface DopplerVelocity {
  readonly east: number;
  readonly north: number;
  readonly sigma: number;
}

/** A gated fix in degrees, meters and seconds. */
export interface PositionObservation {
  readonly t: number;
  readonly latitude: number;
  readonly longitude: number;
  readonly accuracy: number;
  /** Doppler speed in m/s. */
  readonly speed: number | null;
  readonly velocity: DopplerVelocity | null;
}

export class UngatedFixError extends Error {
  constructor(readonly t: number) {
    super(`Fix at ${t} ms has no horizontal accuracy and must be gated first`);
  }
}

/** A zero speed needs no bearing to be a velocity measurement. */
export function observeFix(fix: Fix): PositionObservation {
  if (fix.horizontalAccuracyDm === null) throw new UngatedFixError(fix.t);
  const speed = fix.speedCmS === null ? null : fix.speedCmS / 100;
  let velocity: DopplerVelocity | null = null;
  if (speed !== null && (fix.bearingCentiDeg !== null || speed === 0)) {
    const bearing = (fix.bearingCentiDeg ?? 0) * radiansPerCentiDegree;
    const sigma = Math.max(fix.speedAccuracyCmS === null ? defaultSpeedSigma : fix.speedAccuracyCmS / 100, minimumSpeedSigma);
    velocity = { east: speed * Math.sin(bearing), north: speed * Math.cos(bearing), sigma };
  }
  return { t: fix.t, latitude: fix.latitudeE7 / 1e7, longitude: fix.longitudeE7 / 1e7, accuracy: fix.horizontalAccuracyDm / 10, speed, velocity };
}

export interface KalmanEstimate {
  readonly t: number;
  readonly latitude: number;
  readonly longitude: number;
  /** m/s */
  readonly velocityEast: number;
  readonly velocityNorth: number;
}

/** Positions and velocities after the backward pass, one per recorded step. */
export interface SmoothedTrack {
  readonly length: number;
  readonly t: Float64Array;
  readonly latitude: Float64Array;
  readonly longitude: Float64Array;
  readonly velocityEast: Float64Array;
  readonly velocityNorth: Float64Array;
  /** 1 where the filter restarted: the segment from the previous step is not a filtered path. */
  readonly restart: Uint8Array;
}

const n = 4;
const matrixSize = n * n;
/** t, filtered state, filtered covariance, predicted state, predicted covariance. */
const stepStride = 1 + n + matrixSize + n + matrixSize;
const filteredOffset = 1;
const filteredCovarianceOffset = filteredOffset + n;
const predictedOffset = filteredCovarianceOffset + matrixSize;
const predictedCovarianceOffset = predictedOffset + n;

/** Solves `matrix * out = vector` for a symmetric positive-definite 4 x 4 matrix stored row-major at `offset` (Cholesky). */
function solveSymmetric(matrix: Float64Array, offset: number, vector: Float64Array, lower: Float64Array, out: Float64Array): void {
  for (let row = 0; row < n; row += 1) {
    for (let column = 0; column <= row; column += 1) {
      let sum = matrix[offset + row * n + column] ?? 0;
      for (let k = 0; k < column; k += 1) sum -= (lower[row * n + k] ?? 0) * (lower[column * n + k] ?? 0);
      lower[row * n + column] = row === column ? Math.sqrt(sum) : sum / (lower[column * n + column] ?? 1);
    }
  }
  for (let row = 0; row < n; row += 1) {
    let sum = vector[row] ?? 0;
    for (let k = 0; k < row; k += 1) sum -= (lower[row * n + k] ?? 0) * (out[k] ?? 0);
    out[row] = sum / (lower[row * n + row] ?? 1);
  }
  for (let row = n - 1; row >= 0; row -= 1) {
    let sum = out[row] ?? 0;
    for (let k = row + 1; k < n; k += 1) sum -= (lower[k * n + row] ?? 0) * (out[k] ?? 0);
    out[row] = sum / (lower[row * n + row] ?? 1);
  }
}

/** Forward-pass record kept in batch mode; a restart begins a segment the smoother does not cross. */
export class KalmanTrace {
  private steps = new Float64Array(stepStride * 1024);
  private restarts = new Uint8Array(1024);
  private count = 0;

  get length(): number {
    return this.count;
  }

  record(t: number, filtered: Float64Array, filteredCovariance: Float64Array, predicted: Float64Array, predictedCovariance: Float64Array, restart: boolean): void {
    if (this.count === this.restarts.length) {
      const steps = new Float64Array(this.steps.length * 2);
      steps.set(this.steps);
      this.steps = steps;
      const restarts = new Uint8Array(this.restarts.length * 2);
      restarts.set(this.restarts);
      this.restarts = restarts;
    }
    const base = this.count * stepStride;
    this.steps[base] = t;
    this.steps.set(filtered, base + filteredOffset);
    this.steps.set(filteredCovariance, base + filteredCovarianceOffset);
    this.steps.set(predicted, base + predictedOffset);
    this.steps.set(predictedCovariance, base + predictedCovarianceOffset);
    this.restarts[this.count] = restart ? 1 : 0;
    this.count += 1;
  }

  /** Rauch-Tung-Striebel backward pass over the recorded steps (`GPS-031`), O(n). */
  smoothRts(): SmoothedTrack {
    const length = this.count;
    const steps = this.steps;
    const smoothed: SmoothedTrack = {
      length,
      t: new Float64Array(length),
      latitude: new Float64Array(length),
      longitude: new Float64Array(length),
      velocityEast: new Float64Array(length),
      velocityNorth: new Float64Array(length),
      restart: this.restarts.slice(0, length),
    };
    const difference = new Float64Array(n);
    const solution = new Float64Array(n);
    const lower = new Float64Array(matrixSize);
    for (let k = length - 1; k >= 0; k -= 1) {
      const base = k * stepStride;
      const t = steps[base] ?? 0;
      smoothed.t[k] = t;
      let latitude = steps[base + filteredOffset] ?? 0;
      let longitude = steps[base + filteredOffset + 1] ?? 0;
      let velocityEast = steps[base + filteredOffset + 2] ?? 0;
      let velocityNorth = steps[base + filteredOffset + 3] ?? 0;
      if (k < length - 1 && smoothed.restart[k + 1] === 0) {
        const next = base + stepStride;
        const dt = ((steps[next] ?? 0) - t) / 1000;
        const offset = eastNorthBetween(steps[next + predictedOffset] ?? 0, steps[next + predictedOffset + 1] ?? 0, smoothed.latitude[k + 1] ?? 0, smoothed.longitude[k + 1] ?? 0);
        difference[0] = offset.east;
        difference[1] = offset.north;
        difference[2] = (smoothed.velocityEast[k + 1] ?? 0) - (steps[next + predictedOffset + 2] ?? 0);
        difference[3] = (smoothed.velocityNorth[k + 1] ?? 0) - (steps[next + predictedOffset + 3] ?? 0);
        solveSymmetric(steps, next + predictedCovarianceOffset, difference, lower, solution);
        solution[2] = (solution[2] ?? 0) + dt * (solution[0] ?? 0);
        solution[3] = (solution[3] ?? 0) + dt * (solution[1] ?? 0);
        const correction = (row: number): number => {
          let sum = 0;
          for (let column = 0; column < n; column += 1) sum += (steps[base + filteredCovarianceOffset + row * n + column] ?? 0) * (solution[column] ?? 0);
          return sum;
        };
        const position = displace(latitude, longitude, correction(0), correction(1));
        latitude = position.latitude;
        longitude = position.longitude;
        velocityEast += correction(2);
        velocityNorth += correction(3);
      }
      smoothed.latitude[k] = latitude;
      smoothed.longitude[k] = longitude;
      smoothed.velocityEast[k] = velocityEast;
      smoothed.velocityNorth[k] = velocityNorth;
    }
    return smoothed;
  }
}

/** Planar position-velocity Kalman filter in a sliding east-north frame anchored on the estimate (`GPS-031` forward pass). */
export class PlanarKalman {
  private readonly accelerationVariance: number;
  private readonly initialVelocityVariance: number;
  private readonly trace: KalmanTrace | null;
  /** Latitude and longitude in degrees, velocity east and north in m/s. */
  private readonly state = new Float64Array(n);
  /** Row-major covariance of (east, north, velocity east, velocity north) in the frame anchored on the state. */
  private readonly covariance = new Float64Array(matrixSize);
  private readonly predicted = new Float64Array(n);
  private readonly predictedCovariance = new Float64Array(matrixSize);
  private readonly scratch = new Float64Array(matrixSize);
  private readonly gain = new Float64Array(n * 2);
  private t: number | null = null;

  constructor(profile: RecordingProfile, trace: KalmanTrace | null = null) {
    this.accelerationVariance = (profile.accelerationNoiseMmS2 / 1000) ** 2;
    this.initialVelocityVariance = (profile.maxSpeedMmS / 2000) ** 2;
    this.trace = trace;
  }

  get estimate(): KalmanEstimate | null {
    return this.t === null ? null : this.snapshot(this.t);
  }

  /** Restarts the filter on an observation, dropping the previous estimate (`GPS-030`). */
  reset(observation: PositionObservation): KalmanEstimate {
    const positionVariance = Math.max(observation.accuracy, minimumPositionSigma) ** 2;
    const velocity = observation.velocity;
    const velocityVariance = velocity === null ? this.initialVelocityVariance : velocity.sigma ** 2;
    this.state[0] = observation.latitude;
    this.state[1] = observation.longitude;
    this.state[2] = velocity?.east ?? 0;
    this.state[3] = velocity?.north ?? 0;
    this.covariance.fill(0);
    this.covariance[0] = positionVariance;
    this.covariance[5] = positionVariance;
    this.covariance[10] = velocityVariance;
    this.covariance[15] = velocityVariance;
    this.t = observation.t;
    this.trace?.record(observation.t, this.state, this.covariance, this.state, this.covariance, true);
    return this.snapshot(observation.t);
  }

  /** Predicts to the observation and applies it, or returns `null` and keeps the estimate when its innovation fails the gate (rule 4). */
  update(observation: PositionObservation): KalmanEstimate | null {
    if (this.t === null) return this.reset(observation);
    this.predict(Math.max(observation.t - this.t, 0) / 1000);
    const p = this.predictedCovariance;
    const innovation = eastNorthBetween(this.predicted[0] ?? 0, this.predicted[1] ?? 0, observation.latitude, observation.longitude);
    const positionVariance = Math.max(observation.accuracy, minimumPositionSigma) ** 2;
    const s00 = (p[0] ?? 0) + positionVariance;
    const s01 = p[1] ?? 0;
    const s11 = (p[5] ?? 0) + positionVariance;
    const { east, north } = innovation;
    const mahalanobis = (s11 * east * east - 2 * s01 * east * north + s00 * north * north) / (s00 * s11 - s01 * s01);
    if (mahalanobis > innovationGate) return null;
    this.state.set(this.predicted);
    this.covariance.set(p);
    this.correct(0, east, north, positionVariance);
    const velocity = observation.velocity;
    if (velocity !== null) this.correct(2, velocity.east - (this.state[2] ?? 0), velocity.north - (this.state[3] ?? 0), velocity.sigma ** 2);
    this.t = observation.t;
    this.trace?.record(observation.t, this.state, this.covariance, this.predicted, this.predictedCovariance, false);
    return this.snapshot(observation.t);
  }

  private snapshot(t: number): KalmanEstimate {
    return { t, latitude: this.state[0] ?? 0, longitude: this.state[1] ?? 0, velocityEast: this.state[2] ?? 0, velocityNorth: this.state[3] ?? 0 };
  }

  /** Constant-velocity model: x = F x, P = F P F^T + Q with piecewise-constant white acceleration. */
  private predict(dt: number): void {
    const velocityEast = this.state[2] ?? 0;
    const velocityNorth = this.state[3] ?? 0;
    const position = displace(this.state[0] ?? 0, this.state[1] ?? 0, velocityEast * dt, velocityNorth * dt);
    this.predicted[0] = position.latitude;
    this.predicted[1] = position.longitude;
    this.predicted[2] = velocityEast;
    this.predicted[3] = velocityNorth;
    const p = this.covariance;
    const fp = this.scratch;
    const out = this.predictedCovariance;
    for (let row = 0; row < n; row += 1) {
      for (let column = 0; column < n; column += 1) fp[row * n + column] = (p[row * n + column] ?? 0) + (row < 2 ? dt * (p[(row + 2) * n + column] ?? 0) : 0);
    }
    for (let row = 0; row < n; row += 1) {
      for (let column = 0; column < n; column += 1) out[row * n + column] = (fp[row * n + column] ?? 0) + (column < 2 ? dt * (fp[row * n + column + 2] ?? 0) : 0);
    }
    const q = this.accelerationVariance;
    const dt2 = dt * dt;
    for (let axis = 0; axis < 2; axis += 1) {
      const velocityAxis = axis + 2;
      out[axis * n + axis] = (out[axis * n + axis] ?? 0) + (q * dt2 * dt2) / 4;
      out[velocityAxis * n + velocityAxis] = (out[velocityAxis * n + velocityAxis] ?? 0) + q * dt2;
      out[axis * n + velocityAxis] = (out[axis * n + velocityAxis] ?? 0) + (q * dt2 * dt) / 2;
      out[velocityAxis * n + axis] = (out[velocityAxis * n + axis] ?? 0) + (q * dt2 * dt) / 2;
    }
  }

  /** Update of the state pair starting at `index` with innovation (y0, y1) and isotropic measurement variance. */
  private correct(index: number, y0: number, y1: number, variance: number): void {
    const p = this.covariance;
    const gain = this.gain;
    const s00 = (p[index * n + index] ?? 0) + variance;
    const s01 = p[index * n + index + 1] ?? 0;
    const s11 = (p[(index + 1) * n + index + 1] ?? 0) + variance;
    const determinant = s00 * s11 - s01 * s01;
    for (let row = 0; row < n; row += 1) {
      const p0 = p[row * n + index] ?? 0;
      const p1 = p[row * n + index + 1] ?? 0;
      gain[row * 2] = (p0 * s11 - p1 * s01) / determinant;
      gain[row * 2 + 1] = (p1 * s00 - p0 * s01) / determinant;
    }
    const correction = (row: number): number => (gain[row * 2] ?? 0) * y0 + (gain[row * 2 + 1] ?? 0) * y1;
    const position = displace(this.state[0] ?? 0, this.state[1] ?? 0, correction(0), correction(1));
    this.state[0] = position.latitude;
    this.state[1] = position.longitude;
    this.state[2] = (this.state[2] ?? 0) + correction(2);
    this.state[3] = (this.state[3] ?? 0) + correction(3);
    const updated = this.scratch;
    for (let row = 0; row < n; row += 1) {
      for (let column = 0; column < n; column += 1) {
        const reduction = (gain[row * 2] ?? 0) * (p[index * n + column] ?? 0) + (gain[row * 2 + 1] ?? 0) * (p[(index + 1) * n + column] ?? 0);
        updated[row * n + column] = (p[row * n + column] ?? 0) - reduction;
      }
    }
    for (let row = 0; row < n; row += 1) {
      for (let column = row; column < n; column += 1) {
        const symmetric = ((updated[row * n + column] ?? 0) + (updated[column * n + row] ?? 0)) / 2;
        p[row * n + column] = symmetric;
        p[column * n + row] = symmetric;
      }
    }
  }
}
