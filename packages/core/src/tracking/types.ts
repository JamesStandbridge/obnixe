/**
 * Sample model shared by the native module bridge, the codecs, the processing stages and the file imports.
 * Units are the integer units of the raw journal (annex C); `t` is in milliseconds since the recording's time origin,
 * on the monotonic time base (`GPS-012`).
 */

export interface Fix {
  readonly type: "fix";
  readonly t: number;
  /** `t` minus the GNSS timestamp of the fix: only used to detect stale fixes. */
  readonly fixAgeMs: number;
  readonly latitudeE7: number;
  readonly longitudeE7: number;
  readonly altitudeEllipsoidMm: number | null;
  readonly altitudeMslMm: number | null;
  readonly horizontalAccuracyDm: number | null;
  readonly verticalAccuracyDm: number | null;
  readonly speedCmS: number | null;
  readonly speedAccuracyCmS: number | null;
  readonly bearingCentiDeg: number | null;
  readonly bearingAccuracyCentiDeg: number | null;
  readonly simulated: boolean;
}

export interface PressureSample {
  readonly type: "pressure";
  readonly t: number;
  readonly pascals: number;
}

export interface StepSample {
  readonly type: "steps";
  readonly t: number;
  /** Steps counted since the start of the recording. */
  readonly count: number;
}

export type HeartRateContact = "absent" | "contact" | "unsupported";

export interface HeartRateSample {
  readonly type: "heart_rate";
  readonly t: number;
  readonly bpm: number;
  readonly contact: HeartRateContact;
  /** Last RR interval in 1/1024 s. */
  readonly rrInterval: number | null;
}

/**
 * Cadence from a Bluetooth sensor (`SPT-008`): pedal revolutions per minute from a Cycling Speed and Cadence sensor, steps per
 * minute from a Running Speed and Cadence footpod.
 */
export interface CadenceSample {
  readonly type: "cadence";
  readonly t: number;
  readonly perMinute: number;
}

/** A Cycling Power Measurement (`SPT-008`), from a pedal or crank meter or a running power footpod. */
export interface PowerSample {
  readonly type: "power";
  readonly t: number;
  readonly watts: number;
  /** Pedal revolutions per minute from the meter's crank data, `null` without one. */
  readonly cadence: number | null;
}

export type Sample = Fix | PressureSample | StepSample | HeartRateSample | CadenceSample | PowerSample;

export type TrackerMarkKind = "start" | "pause" | "resume" | "lap" | "stop";

export interface TrackerMark {
  readonly kind: TrackerMarkKind;
  readonly t: number;
}

/** Stored in nullable integer columns where the value is absent. */
export const absentValue = -2_147_483_648;

export interface FixColumns {
  readonly length: number;
  readonly t: Uint32Array;
  readonly fixAgeMs: Int32Array;
  readonly latitudeE7: Int32Array;
  readonly longitudeE7: Int32Array;
  readonly altitudeEllipsoidMm: Int32Array;
  readonly altitudeMslMm: Int32Array;
  readonly horizontalAccuracyDm: Int32Array;
  readonly verticalAccuracyDm: Int32Array;
  readonly speedCmS: Int32Array;
  readonly speedAccuracyCmS: Int32Array;
  readonly bearingCentiDeg: Int32Array;
  readonly bearingAccuracyCentiDeg: Int32Array;
  readonly simulated: Uint8Array;
}

export interface PressureColumns {
  readonly length: number;
  readonly t: Uint32Array;
  readonly pascals: Uint32Array;
}

export interface StepColumns {
  readonly length: number;
  readonly t: Uint32Array;
  readonly count: Uint32Array;
}

export interface HeartRateColumns {
  readonly length: number;
  readonly t: Uint32Array;
  readonly bpm: Uint16Array;
  readonly rrInterval: Int32Array;
}

export interface CadenceColumns {
  readonly length: number;
  readonly t: Uint32Array;
  readonly perMinute: Uint16Array;
}

export interface PowerColumns {
  readonly length: number;
  readonly t: Uint32Array;
  readonly watts: Uint16Array;
  /** `absentValue` without crank data. */
  readonly cadence: Int32Array;
}

/** Columnar layout of a whole track, decoded straight into typed arrays (`PRF-031`); each stream is ordered by `t`. */
export interface SampleColumns {
  readonly fixes: FixColumns;
  readonly pressure: PressureColumns;
  readonly steps: StepColumns;
  readonly heartRate: HeartRateColumns;
  readonly cadence: CadenceColumns;
  readonly power: PowerColumns;
}

export class UnorderedSamplesError extends Error {
  constructor(readonly stream: Sample["type"], readonly index: number) {
    super(`${stream} sample ${index} goes back in time`);
  }
}

const orAbsent = (value: number | null): number => value ?? absentValue;

export function toSampleColumns(samples: readonly Sample[]): SampleColumns {
  let fixCount = 0;
  let pressureCount = 0;
  let stepCount = 0;
  let heartRateCount = 0;
  let cadenceCount = 0;
  let powerCount = 0;
  for (const sample of samples) {
    switch (sample.type) {
      case "fix":
        fixCount += 1;
        break;
      case "pressure":
        pressureCount += 1;
        break;
      case "steps":
        stepCount += 1;
        break;
      case "heart_rate":
        heartRateCount += 1;
        break;
      case "cadence":
        cadenceCount += 1;
        break;
      case "power":
        powerCount += 1;
        break;
      default: {
        const unreachable: never = sample;
        throw new Error(`Unhandled sample ${JSON.stringify(unreachable)}`);
      }
    }
  }
  const fixes: FixColumns = {
    length: fixCount,
    t: new Uint32Array(fixCount),
    fixAgeMs: new Int32Array(fixCount),
    latitudeE7: new Int32Array(fixCount),
    longitudeE7: new Int32Array(fixCount),
    altitudeEllipsoidMm: new Int32Array(fixCount),
    altitudeMslMm: new Int32Array(fixCount),
    horizontalAccuracyDm: new Int32Array(fixCount),
    verticalAccuracyDm: new Int32Array(fixCount),
    speedCmS: new Int32Array(fixCount),
    speedAccuracyCmS: new Int32Array(fixCount),
    bearingCentiDeg: new Int32Array(fixCount),
    bearingAccuracyCentiDeg: new Int32Array(fixCount),
    simulated: new Uint8Array(fixCount),
  };
  const pressure: PressureColumns = { length: pressureCount, t: new Uint32Array(pressureCount), pascals: new Uint32Array(pressureCount) };
  const steps: StepColumns = { length: stepCount, t: new Uint32Array(stepCount), count: new Uint32Array(stepCount) };
  const heartRate: HeartRateColumns = { length: heartRateCount, t: new Uint32Array(heartRateCount), bpm: new Uint16Array(heartRateCount), rrInterval: new Int32Array(heartRateCount) };
  const cadence: CadenceColumns = { length: cadenceCount, t: new Uint32Array(cadenceCount), perMinute: new Uint16Array(cadenceCount) };
  const power: PowerColumns = { length: powerCount, t: new Uint32Array(powerCount), watts: new Uint16Array(powerCount), cadence: new Int32Array(powerCount) };
  let fix = 0;
  let pressureIndex = 0;
  let stepIndex = 0;
  let heartRateIndex = 0;
  let cadenceIndex = 0;
  let powerIndex = 0;
  for (const sample of samples) {
    switch (sample.type) {
      case "fix":
        if (fix > 0 && sample.t < (fixes.t[fix - 1] ?? 0)) throw new UnorderedSamplesError("fix", fix);
        fixes.t[fix] = sample.t;
        fixes.fixAgeMs[fix] = sample.fixAgeMs;
        fixes.latitudeE7[fix] = sample.latitudeE7;
        fixes.longitudeE7[fix] = sample.longitudeE7;
        fixes.altitudeEllipsoidMm[fix] = orAbsent(sample.altitudeEllipsoidMm);
        fixes.altitudeMslMm[fix] = orAbsent(sample.altitudeMslMm);
        fixes.horizontalAccuracyDm[fix] = orAbsent(sample.horizontalAccuracyDm);
        fixes.verticalAccuracyDm[fix] = orAbsent(sample.verticalAccuracyDm);
        fixes.speedCmS[fix] = orAbsent(sample.speedCmS);
        fixes.speedAccuracyCmS[fix] = orAbsent(sample.speedAccuracyCmS);
        fixes.bearingCentiDeg[fix] = orAbsent(sample.bearingCentiDeg);
        fixes.bearingAccuracyCentiDeg[fix] = orAbsent(sample.bearingAccuracyCentiDeg);
        fixes.simulated[fix] = sample.simulated ? 1 : 0;
        fix += 1;
        break;
      case "pressure":
        if (pressureIndex > 0 && sample.t < (pressure.t[pressureIndex - 1] ?? 0)) throw new UnorderedSamplesError("pressure", pressureIndex);
        pressure.t[pressureIndex] = sample.t;
        pressure.pascals[pressureIndex] = sample.pascals;
        pressureIndex += 1;
        break;
      case "steps":
        if (stepIndex > 0 && sample.t < (steps.t[stepIndex - 1] ?? 0)) throw new UnorderedSamplesError("steps", stepIndex);
        steps.t[stepIndex] = sample.t;
        steps.count[stepIndex] = sample.count;
        stepIndex += 1;
        break;
      case "heart_rate":
        if (heartRateIndex > 0 && sample.t < (heartRate.t[heartRateIndex - 1] ?? 0)) throw new UnorderedSamplesError("heart_rate", heartRateIndex);
        heartRate.t[heartRateIndex] = sample.t;
        heartRate.bpm[heartRateIndex] = sample.bpm;
        heartRate.rrInterval[heartRateIndex] = orAbsent(sample.rrInterval);
        heartRateIndex += 1;
        break;
      case "cadence":
        if (cadenceIndex > 0 && sample.t < (cadence.t[cadenceIndex - 1] ?? 0)) throw new UnorderedSamplesError("cadence", cadenceIndex);
        cadence.t[cadenceIndex] = sample.t;
        cadence.perMinute[cadenceIndex] = sample.perMinute;
        cadenceIndex += 1;
        break;
      case "power":
        if (powerIndex > 0 && sample.t < (power.t[powerIndex - 1] ?? 0)) throw new UnorderedSamplesError("power", powerIndex);
        power.t[powerIndex] = sample.t;
        power.watts[powerIndex] = sample.watts;
        power.cadence[powerIndex] = orAbsent(sample.cadence);
        powerIndex += 1;
        break;
      default: {
        const unreachable: never = sample;
        throw new Error(`Unhandled sample ${JSON.stringify(unreachable)}`);
      }
    }
  }
  return { fixes, pressure, steps, heartRate, cadence, power };
}
