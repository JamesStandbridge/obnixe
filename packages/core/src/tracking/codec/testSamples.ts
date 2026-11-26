import type { Fix, Sample, TrackerMark } from "../types.ts";

export interface SyntheticActivity {
  readonly samples: readonly Sample[];
  readonly marks: readonly TrackerMark[];
}

export interface SyntheticOptions {
  readonly seconds: number;
  readonly seed: number;
  readonly heartRate: boolean;
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** First-order Gauss-Markov error of standard deviation `sigma` and correlation time `tau` (s), sampled every second. */
class GaussMarkov {
  private value: number;
  private readonly decay: number;
  private readonly drive: number;

  constructor(
    private readonly gaussian: () => number,
    sigma: number,
    tau: number,
  ) {
    this.decay = Math.exp(-1 / tau);
    this.drive = sigma * Math.sqrt(1 - this.decay * this.decay);
    this.value = gaussian() * sigma;
  }

  next(): number {
    this.value = this.value * this.decay + this.drive * this.gaussian();
    return this.value;
  }
}

const metersPerDegree = 111_320;

/**
 * A 1 Hz mountain run as the native module records it: GNSS position, altitude and accuracy with correlated errors,
 * Doppler speed and bearing with white noise, a barometer and a pedometer at 1 Hz, optionally a heart-rate strap.
 */
export function syntheticActivity(options: SyntheticOptions): SyntheticActivity {
  const random = mulberry32(options.seed);
  const gaussian = (): number => Math.sqrt(-2 * Math.log(1 - random())) * Math.cos(2 * Math.PI * random());
  const north = new GaussMarkov(gaussian, 2.5, 20);
  const east = new GaussMarkov(gaussian, 2.5, 20);
  const vertical = new GaussMarkov(gaussian, 4, 60);
  const accuracy = new GaussMarkov(gaussian, 8, 120);
  const pressureDrift = new GaussMarkov(gaussian, 15, 600);
  const samples: Sample[] = [];
  let latitude = 45.8326;
  let longitude = 6.8652;
  let heading = random() * Math.PI * 2;
  let altitude = 1035;
  let steps = 0;
  let bpm = 120;
  for (let second = 0; second < options.seconds; second += 1) {
    const t = second * 1000 + Math.floor(random() * 4);
    heading += gaussian() * 0.03;
    const speed = 2.9 + Math.sin(second / 90) * 0.6;
    latitude += (speed * Math.cos(heading)) / metersPerDegree;
    longitude += (speed * Math.sin(heading)) / (metersPerDegree * Math.cos((latitude * Math.PI) / 180));
    altitude += speed * Math.sin(second / 300) * 0.08;
    const metersPerDegreeEast = metersPerDegree * Math.cos((latitude * Math.PI) / 180);
    const horizontalAccuracy = 3.5 + Math.abs(accuracy.next()) * 0.3;
    const altitudeEllipsoid = Math.round((altitude + 52.3 + vertical.next()) * 1000);
    const fix: Fix = {
      type: "fix",
      t,
      fixAgeMs: 310 + Math.floor(random() * 6),
      latitudeE7: Math.round((latitude + north.next() / metersPerDegree) * 1e7),
      longitudeE7: Math.round((longitude + east.next() / metersPerDegreeEast) * 1e7),
      altitudeEllipsoidMm: altitudeEllipsoid,
      altitudeMslMm: second % 97 === 0 ? null : altitudeEllipsoid - 52_300 + Math.round(Math.sin(second / 1000) * 40),
      horizontalAccuracyDm: Math.round(horizontalAccuracy * 10),
      verticalAccuracyDm: Math.round(horizontalAccuracy * 16),
      speedCmS: Math.max(0, Math.round((speed + gaussian() * 0.12) * 100)),
      speedAccuracyCmS: Math.round(horizontalAccuracy * 6),
      bearingCentiDeg: ((Math.round(((heading + gaussian() * 0.05) * 18_000) / Math.PI) % 36_000) + 36_000) % 36_000,
      bearingAccuracyCentiDeg: second % 13 === 0 ? null : Math.round(horizontalAccuracy * 150),
      simulated: false,
    };
    samples.push(fix);
    const pascals = Math.round(101_325 * (1 - 2.25577e-5 * altitude) ** 5.25588 + pressureDrift.next() + gaussian() * 1.5);
    samples.push({ type: "pressure", t: t + 300, pascals });
    steps += 2 + (random() < 0.8 ? 1 : 0);
    samples.push({ type: "steps", t: t + 500, count: steps });
    if (options.heartRate) {
      bpm = Math.min(190, Math.max(90, bpm + Math.round(gaussian())));
      samples.push({ type: "heart_rate", t: t + 700, bpm, contact: "contact", rrInterval: second % 29 === 0 ? null : Math.max(1, Math.round(61_440 / bpm + gaussian() * 8)) });
    }
  }
  const end = options.seconds * 1000;
  const marks: TrackerMark[] = [
    { kind: "start", t: 0 },
    { kind: "lap", t: Math.floor(end / 3) },
    { kind: "pause", t: Math.floor(end / 2) },
    { kind: "resume", t: Math.floor(end / 2) + Math.floor(end / 10) },
    { kind: "stop", t: end },
  ];
  return { samples, marks };
}
