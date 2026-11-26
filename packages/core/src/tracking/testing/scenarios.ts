import type { SportKey } from "@obnixe/schema";
import { displace } from "../geo.ts";
import type { Fix, Sample } from "../types.ts";
import { createRandom } from "./random.ts";

/** A straight leg at constant speed with a constant grade, or a stop. */
export type Leg =
  | { readonly kind: "move"; readonly meters: number; readonly speed: number; readonly bearing: number; readonly climb: number }
  | { readonly kind: "stop"; readonly durationMs: number };

export interface Route {
  readonly latitude: number;
  readonly longitude: number;
  /** Orthometric altitude in meters. */
  readonly altitude: number;
  readonly legs: readonly Leg[];
}

/** Ground truth sampled every `intervalMs`, in degrees, meters and m/s. */
export interface Truth {
  readonly length: number;
  readonly t: Float64Array;
  readonly latitude: Float64Array;
  readonly longitude: Float64Array;
  readonly altitude: Float64Array;
  readonly speed: Float64Array;
  readonly bearing: Float64Array;
  readonly moving: Uint8Array;
  readonly distance: number;
  readonly ascent: number;
  readonly descent: number;
}

export function move(meters: number, speed: number, bearing: number, climb = 0): Leg {
  return { kind: "move", meters, speed, bearing, climb };
}

export function stop(durationMs: number): Leg {
  return { kind: "stop", durationMs };
}

const substeps = 10;
const minimumSpeed = 0.2;

function turnToward(heading: number, target: number, maxTurn: number): number {
  const difference = ((((target - heading) % 360) + 540) % 360) - 180;
  return (((heading + Math.max(-maxTurn, Math.min(maxTurn, difference))) % 360) + 360) % 360;
}

/**
 * Integrates the route in `substeps` per sample with continuous kinematics: speed changes at `acceleration`, braking ahead of
 * slower legs and stops, and the heading turns at `turnRate` degrees per second, so corners are rounded.
 */
export function buildTruth(route: Route, intervalMs = 1000, acceleration = 2, turnRate = 60): Truth {
  const columns = { t: [] as number[], latitude: [] as number[], longitude: [] as number[], altitude: [] as number[], speed: [] as number[], bearing: [] as number[], moving: [] as number[] };
  const first = route.legs.find((leg) => leg.kind === "move");
  let latitude = route.latitude;
  let longitude = route.longitude;
  let altitude = route.altitude;
  let speed = 0;
  let heading = first?.kind === "move" ? first.bearing : 0;
  let legIndex = 0;
  let legProgress = 0;
  let distance = 0;
  const dt = intervalMs / substeps / 1000;
  for (let step = 0; ; step += 1) {
    if (step % substeps === 0) {
      columns.t.push((step / substeps) * intervalMs);
      columns.latitude.push(latitude);
      columns.longitude.push(longitude);
      columns.altitude.push(altitude);
      columns.speed.push(speed);
      columns.bearing.push(heading);
      columns.moving.push(speed > 0 ? 1 : 0);
      if (legIndex >= route.legs.length) break;
    }
    const leg = route.legs[legIndex];
    if (leg === undefined) {
      speed = 0;
      continue;
    }
    if (leg.kind === "stop") {
      speed = 0;
      legProgress += dt * 1000;
      if (legProgress >= leg.durationMs) {
        legIndex += 1;
        legProgress = 0;
      }
      continue;
    }
    const next = route.legs[legIndex + 1];
    const exitSpeed = next === undefined || next.kind === "stop" ? 0 : Math.min(next.speed, leg.speed);
    const remaining = leg.meters - legProgress;
    const brakingDistance = (speed * speed - exitSpeed * exitSpeed) / (2 * acceleration);
    const target = remaining <= brakingDistance ? exitSpeed : leg.speed;
    speed = Math.max(speed > target ? Math.max(speed - acceleration * dt, target) : Math.min(speed + acceleration * dt, target), minimumSpeed);
    heading = turnToward(heading, leg.bearing, turnRate * dt);
    const meters = Math.min(speed * dt, remaining);
    const radians = (heading * Math.PI) / 180;
    const position = displace(latitude, longitude, meters * Math.sin(radians), meters * Math.cos(radians));
    latitude = position.latitude;
    longitude = position.longitude;
    altitude += (leg.climb * meters) / leg.meters;
    distance += meters;
    legProgress += meters;
    if (legProgress >= leg.meters - 1e-9) {
      legIndex += 1;
      legProgress = 0;
      if (route.legs[legIndex]?.kind === "stop") speed = 0;
    }
  }
  const moves = route.legs.filter((leg): leg is Extract<Leg, { kind: "move" }> => leg.kind === "move");
  return {
    length: columns.t.length,
    t: Float64Array.from(columns.t),
    latitude: Float64Array.from(columns.latitude),
    longitude: Float64Array.from(columns.longitude),
    altitude: Float64Array.from(columns.altitude),
    speed: Float64Array.from(columns.speed),
    bearing: Float64Array.from(columns.bearing),
    moving: Uint8Array.from(columns.moving),
    distance,
    ascent: moves.reduce((total, leg) => total + Math.max(leg.climb, 0), 0),
    descent: moves.reduce((total, leg) => total + Math.max(-leg.climb, 0), 0),
  };
}

/** What the phone reports: σ are per axis, in meters and m/s. */
export interface SensorModel {
  /** Horizontal σ oscillating between `min` and `max` over `periodMs`, reported as the accuracy. */
  readonly accuracy: { readonly min: number; readonly max: number; readonly periodMs: number };
  /** Gauss-Markov correlation time of the horizontal error. */
  readonly correlationMs: number;
  /** Multipath jumps after the first fix; a wrong first fix is the teleport case. */
  readonly spikes: { readonly probability: number; readonly meters: number } | null;
  readonly gaps: readonly { readonly fromMs: number; readonly toMs: number }[];
  readonly speedSigma: number;
  readonly altitude: { readonly sigma: number; readonly correlationMs: number; readonly ellipsoidOnly: boolean; readonly undulation: number };
  readonly barometer: { readonly driftMetersPerHour: number; readonly sigma: number } | null;
  /** Steps per minute while moving, `null` without pedometer. */
  readonly cadence: number | null;
  readonly simulated: boolean;
}

export const clearSky: SensorModel = {
  accuracy: { min: 3, max: 5, periodMs: 120_000 },
  correlationMs: 20_000,
  spikes: null,
  gaps: [],
  speedSigma: 0.2,
  altitude: { sigma: 6, correlationMs: 2000, ellipsoidOnly: false, undulation: 50 },
  barometer: null,
  cadence: null,
  simulated: false,
};

export interface Simulation {
  /** Ordered by `t`: a fix per truth sample outside gaps, with pressure and cumulative steps when modeled. */
  readonly samples: readonly Sample[];
  /** Times of the fixes displaced by a multipath spike. */
  readonly spikes: ReadonlySet<number>;
}

export function simulate(truth: Truth, sensors: SensorModel, seed: number): Simulation {
  const random = createRandom(seed);
  const samples: Sample[] = [];
  const spikes = new Set<number>();
  let east = random.gaussian();
  let north = random.gaussian();
  let vertical = random.gaussian();
  let steps = 0;
  const { accuracy, altitude } = sensors;
  for (let index = 0; index < truth.length; index += 1) {
    const t = truth.t[index] ?? 0;
    const dtMs = index === 0 ? 0 : t - (truth.t[index - 1] ?? 0);
    const horizontalDecay = Math.exp(-dtMs / sensors.correlationMs);
    east = horizontalDecay * east + Math.sqrt(1 - horizontalDecay ** 2) * random.gaussian();
    north = horizontalDecay * north + Math.sqrt(1 - horizontalDecay ** 2) * random.gaussian();
    const verticalDecay = Math.exp(-dtMs / altitude.correlationMs);
    vertical = verticalDecay * vertical + Math.sqrt(1 - verticalDecay ** 2) * random.gaussian();
    const moving = truth.moving[index] === 1;
    const trueAltitude = truth.altitude[index] ?? 0;
    if (sensors.cadence !== null) {
      if (moving) steps += (sensors.cadence * dtMs) / 60_000;
      samples.push({ type: "steps", t, count: Math.floor(steps) });
    }
    if (sensors.barometer !== null) {
      const drifted = trueAltitude + (sensors.barometer.driftMetersPerHour * t) / 3_600_000 + sensors.barometer.sigma * random.gaussian();
      samples.push({ type: "pressure", t, pascals: Math.round(101_325 * (1 - drifted / 44_330.77) ** (1 / 0.190263)) });
    }
    if (sensors.gaps.some((gap) => t >= gap.fromMs && t < gap.toMs)) continue;
    const sigma = accuracy.min + ((accuracy.max - accuracy.min) * (1 - Math.cos((2 * Math.PI * t) / accuracy.periodMs))) / 2;
    let offsetEast = sigma * east;
    let offsetNorth = sigma * north;
    if (sensors.spikes !== null && index > 0 && random.uniform() < sensors.spikes.probability) {
      const angle = 2 * Math.PI * random.uniform();
      offsetEast += sensors.spikes.meters * Math.sin(angle);
      offsetNorth += sensors.spikes.meters * Math.cos(angle);
      spikes.add(t);
    }
    const position = displace(truth.latitude[index] ?? 0, truth.longitude[index] ?? 0, offsetEast, offsetNorth);
    const gnssAltitude = trueAltitude + altitude.sigma * vertical;
    const speed = moving ? Math.max(0, (truth.speed[index] ?? 0) + sensors.speedSigma * random.gaussian()) : 0;
    const bearing = ((((truth.bearing[index] ?? 0) + 2 * random.gaussian()) % 360) + 360) % 360;
    const fix: Fix = {
      type: "fix",
      t,
      fixAgeMs: 100 + Math.floor(400 * random.uniform()),
      latitudeE7: Math.round(position.latitude * 1e7),
      longitudeE7: Math.round(position.longitude * 1e7),
      altitudeEllipsoidMm: Math.round((gnssAltitude + altitude.undulation) * 1000),
      altitudeMslMm: altitude.ellipsoidOnly ? null : Math.round(gnssAltitude * 1000),
      horizontalAccuracyDm: Math.max(1, Math.round(sigma * 10)),
      verticalAccuracyDm: Math.round(altitude.sigma * 10),
      speedCmS: Math.round(speed * 100),
      speedAccuracyCmS: Math.round(sensors.speedSigma * 100),
      bearingCentiDeg: moving ? Math.round(bearing * 100) % 36_000 : null,
      bearingAccuracyCentiDeg: moving ? 200 : null,
      simulated: sensors.simulated,
    };
    samples.push(fix);
  }
  return { samples, spikes };
}

export interface Scenario extends Simulation {
  readonly sport: SportKey;
  readonly truth: Truth;
}

const grenoble = { latitude: 45.1885, longitude: 5.7245 };
/** EGM96 undulation at Grenoble from the GeographicLib 15' grid. */
export const grenobleUndulation = 50.805;

function scenario(sport: SportKey, route: Route, sensors: SensorModel, seed: number): Scenario {
  const truth = buildTruth(route);
  return { sport, truth, ...simulate(truth, sensors, seed) };
}

/** The synthetic scenarios of the signal stages (`TST-002`, `TST-010`). */
export const stageScenarios = {
  standstill10min: (seed: number): Scenario =>
    scenario("run", { ...grenoble, altitude: 214, legs: [stop(600_000)] }, { ...clearSky, accuracy: { min: 5, max: 15, periodMs: 180_000 }, correlationMs: 30_000 }, seed),

  teleportRecovery: (seed: number): Scenario => {
    const base = scenario("run", { ...grenoble, altitude: 214, legs: [move(3000, 3.3, 60)] }, clearSky, seed);
    const samples = [...base.samples];
    const first = samples.findIndex((sample) => sample.type === "fix");
    const fix = samples[first];
    if (fix?.type === "fix") {
      const teleported = displace(fix.latitudeE7 / 1e7, fix.longitudeE7 / 1e7, 400 * Math.sin(2), 400 * Math.cos(2));
      samples[first] = { ...fix, latitudeE7: Math.round(teleported.latitude * 1e7), longitudeE7: Math.round(teleported.longitude * 1e7), horizontalAccuracyDm: 80 };
    }
    return { ...base, samples };
  },

  urbanCanyon: (seed: number): Scenario => {
    const legs: Leg[] = [];
    for (let block = 0; block < 24; block += 1) legs.push(move(250, 3, (block % 4) * 90));
    return scenario("run", { ...grenoble, altitude: 214, legs }, { ...clearSky, accuracy: { min: 14, max: 16, periodMs: 90_000 }, correlationMs: 30_000, spikes: { probability: 0.02, meters: 80 }, speedSigma: 0.4 }, seed);
  },

  flatNoise: (seed: number): Scenario =>
    scenario("run", { ...grenoble, altitude: 214, legs: [move(5000, 3.33, 10), move(5000, 3.33, 190)] }, { ...clearSky, altitude: { ...clearSky.altitude, sigma: 8 } }, seed),

  sawtooth: (seed: number): Scenario => {
    const legs: Leg[] = [];
    for (let climb = 0; climb < 10; climb += 1) legs.push(move(400, 1.5, 0, 50), stop(20_000), move(400, 2.5, 180, -50), move(60, 1.5, 90));
    return scenario("hike", { ...grenoble, altitude: 600, legs }, { ...clearSky, barometer: { driftMetersPerHour: 3, sigma: 0.1 }, cadence: 100 }, seed);
  },

  steepClimb: (seed: number): Scenario =>
    scenario("trail", { ...grenoble, altitude: 900, legs: [move(1080, 0.3, 45, 800)] }, { ...clearSky, barometer: { driftMetersPerHour: 3, sigma: 0.1 }, cadence: 55 }, seed),

  bikeDescent: (seed: number): Scenario => {
    const legs: Leg[] = [];
    for (let bend = 0; bend < 12; bend += 1) {
      const heading = bend % 2 === 0 ? 120 : 240;
      const turn = bend % 2 === 0 ? 20 : -20;
      legs.push(move(600, 19.4, heading, -48), move(16, 15.5, heading, -1), move(12, 11.5, heading, -1));
      for (let step = 1; step < 6; step += 1) legs.push(move(8, 8, heading + step * turn, -0.6));
      legs.push(move(12, 11.5, heading + 6 * turn, -1), move(16, 15.5, heading + 6 * turn, -1));
    }
    return scenario("bike", { ...grenoble, altitude: 1900, legs }, clearSky, seed);
  },

  androidEllipsoid: (seed: number): Scenario =>
    scenario("hike", { ...grenoble, altitude: 214, legs: [move(3000, 1.3, 30, 120)] }, { ...clearSky, altitude: { sigma: 6, correlationMs: 2000, ellipsoidOnly: true, undulation: grenobleUndulation } }, seed),

  simulatedFixes: (seed: number): Scenario => scenario("run", { ...grenoble, altitude: 214, legs: [move(1000, 3.3, 90)] }, { ...clearSky, simulated: true }, seed),
} as const;
