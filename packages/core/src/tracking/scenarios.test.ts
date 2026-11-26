import { describe, expect, it } from "vitest";
import { sports } from "@obnixe/schema";
import type { RecordingProfile } from "@obnixe/schema";
import { ellipsoidDistance } from "./geo.ts";
import { BarometricFusion, distanceMovingAverage, ElevationHysteresis, elevationThresholdMeters, gnssAltitudeFilter, orthometricAltitude, verticalSigma, VerticalSpeedMeter } from "./stages/altitude.ts";
import { FixGate } from "./stages/gate.ts";
import type { GateRejection } from "./stages/gate.ts";
import { KalmanTrace, PlanarKalman } from "./stages/kalman.ts";
import { CadenceMeter, classifyIntervals, motionVerticalSpeedWindowMs } from "./stages/motion.ts";
import type { MotionInput } from "./stages/motion.ts";
import { OutlierRejector } from "./stages/reject.ts";
import type { PositionVerdict, RejectReason } from "./stages/reject.ts";
import { grenobleUndulation, stageScenarios } from "./testing/scenarios.ts";
import type { Scenario } from "./testing/scenarios.ts";
import type { Fix } from "./types.ts";

interface StageRun {
  readonly retained: readonly Extract<PositionVerdict, { retained: true }>[];
  readonly gateRejections: Readonly<Partial<Record<GateRejection, number>>>;
  readonly rejections: Readonly<Partial<Record<RejectReason, number>>>;
  readonly rejected: readonly Fix[];
  readonly simulated: boolean;
  readonly moving: Uint8Array;
  readonly distance: number;
  readonly movingMs: number;
  readonly altitude: Float64Array;
  readonly ascent: number;
  readonly descent: number;
}

/** Batch composition of the stages 2 to 7, the way `processTrack` chains them. */
function runStages(scenario: Scenario): StageRun {
  const profile: RecordingProfile = sports[scenario.sport].recording ?? sports.run.recording;
  const gate = new FixGate(profile);
  const trace = new KalmanTrace();
  const rejector = new OutlierRejector(profile, new PlanarKalman(profile, trace));
  const fusion = new BarometricFusion({ smoothing: true });
  const cadence = new CadenceMeter();
  const context = new Map<Fix, { readonly altitude: number | null; readonly fusedIndex: number | null; readonly cadence: number | null }>();
  let fusedCount = 0;
  const retained: Extract<PositionVerdict, { retained: true }>[] = [];
  const rejected: Fix[] = [];
  const gateRejections: Partial<Record<GateRejection, number>> = {};
  const rejections: Partial<Record<RejectReason, number>> = {};
  let simulated = false;
  let barometer = false;
  const collect = (verdicts: readonly PositionVerdict[]): void => {
    for (const verdict of verdicts) {
      if (verdict.retained) retained.push(verdict);
      else {
        rejections[verdict.reason] = (rejections[verdict.reason] ?? 0) + 1;
        rejected.push(verdict.fix);
      }
    }
  };
  const accept = (fix: Fix): void => {
    simulated ||= fix.simulated;
    const orthometric = orthometricAltitude(fix);
    const fused = orthometric === null ? null : fusion.pushGnss(fix.t, orthometric, verticalSigma(fix));
    context.set(fix, { altitude: barometer ? fused : orthometric, fusedIndex: fused === null ? null : fusedCount++, cadence: cadence.at(fix.t) });
    collect(rejector.push(fix));
  };
  for (const sample of scenario.samples) {
    switch (sample.type) {
      case "fix": {
        const decision = gate.push(sample);
        if (decision.promoted !== null) accept(decision.promoted);
        if (decision.accepted) accept(sample);
        else gateRejections[decision.reason] = (gateRejections[decision.reason] ?? 0) + 1;
        break;
      }
      case "pressure":
        barometer = true;
        fusion.pushPressure(sample);
        break;
      case "steps":
        cadence.push(sample);
        break;
      case "heart_rate":
        break;
      default: {
        const unreachable: never = sample;
        throw new Error(`Unhandled sample ${JSON.stringify(unreachable)}`);
      }
    }
  }
  collect(rejector.flush());
  const smoothed = trace.smoothRts();
  const length = smoothed.length;
  const verticalSpeed = new VerticalSpeedMeter(motionVerticalSpeedWindowMs);
  const gnssAltitude = gnssAltitudeFilter({ smoothing: true });
  const rawAltitude = new Float64Array(length);
  const fusedAltitude = fusion.smoothRts();
  const inputs: MotionInput[] = [];
  for (let index = 0; index < length; index += 1) {
    const verdict = retained[index];
    if (verdict === undefined) throw new Error("Trace and verdicts diverge");
    const { altitude, fusedIndex, cadence: stepRate } = context.get(verdict.fix) ?? { altitude: null, fusedIndex: null, cadence: null };
    rawAltitude[index] = barometer ? (fusedAltitude[fusedIndex ?? -1] ?? Number.NaN) : (altitude ?? Number.NaN);
    if (!barometer && altitude !== null) gnssAltitude.push(verdict.fix.t, altitude, verticalSigma(verdict.fix));
    inputs.push({
      t: smoothed.t[index] ?? 0,
      speed: Math.hypot(smoothed.velocityEast[index] ?? 0, smoothed.velocityNorth[index] ?? 0),
      verticalSpeed: barometer && altitude !== null ? verticalSpeed.push(verdict.fix.t, altitude) : null,
      cadence: stepRate,
      accuracy: (verdict.fix.horizontalAccuracyDm ?? 0) / 10,
      paused: false,
    });
  }
  const moving = classifyIntervals(profile.motion, inputs);
  const cumulative = new Float64Array(length);
  let distance = 0;
  let movingMs = 0;
  for (let index = 1; index < length; index += 1) {
    const counted = moving[index] === 1 && smoothed.restart[index] === 0;
    const step = ellipsoidDistance(smoothed.latitude[index - 1] ?? 0, smoothed.longitude[index - 1] ?? 0, smoothed.latitude[index] ?? 0, smoothed.longitude[index] ?? 0);
    if (counted) {
      distance += step;
      movingMs += (smoothed.t[index] ?? 0) - (smoothed.t[index - 1] ?? 0);
    }
    cumulative[index] = distance;
  }
  const altitude = barometer ? rawAltitude : distanceMovingAverage(cumulative, gnssAltitude.smoothRts());
  const hysteresis = new ElevationHysteresis(barometer ? elevationThresholdMeters.barometer : elevationThresholdMeters.gnss);
  for (let index = 0; index < length; index += 1) {
    const value = altitude[index] ?? Number.NaN;
    if (!Number.isNaN(value)) hysteresis.push(value, moving[index] === 1 && smoothed.restart[index] === 0);
  }
  return { retained, gateRejections, rejections, rejected, simulated, moving, distance, movingMs, altitude, ascent: hysteresis.ascent, descent: hysteresis.descent };
}

const seeds = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];

const truthAt = (scenario: Scenario, fix: Fix): number => scenario.truth.t.indexOf(fix.t);

describe("signal stage scenarios (TST-010)", () => {
  it("are reproducible from their seed (TST-002)", () => {
    for (const build of Object.values(stageScenarios)) {
      expect(build(3).samples).toEqual(build(3).samples);
      expect(build(3).samples).not.toEqual(build(4).samples);
    }
  });

  it("standstill-10min adds at most 5 m and stays stopped (GPS-037)", () => {
    for (const seed of seeds) {
      const run = runStages(stageScenarios.standstill10min(seed));
      expect(run.distance, `seed ${seed}`).toBeLessThanOrEqual(5);
      expect(run.moving.includes(1), `seed ${seed}`).toBe(false);
    }
  });

  it("teleport-recovery corrects a wrong first fix within 10 s, adding at most 20 m (GPS-030)", () => {
    for (const seed of seeds) {
      const scenario = stageScenarios.teleportRecovery(seed);
      const run = runStages(scenario);
      const [first, ...rest] = run.retained;
      const recovery = rest.find((verdict) => verdict.reset);
      expect(recovery, `seed ${seed}`).toBeDefined();
      expect((recovery?.fix.t ?? Infinity) - (first?.fix.t ?? 0), `seed ${seed}`).toBeLessThan(10_000);
      expect(rest.filter((verdict) => verdict.reset)).toHaveLength(1);
      expect(run.distance - scenario.truth.distance, `seed ${seed}`).toBeLessThanOrEqual(20);
    }
  });

  it("urban-canyon keeps the distance within 2.5 % and retains no spike", () => {
    for (const seed of seeds) {
      const scenario = stageScenarios.urbanCanyon(seed);
      const run = runStages(scenario);
      expect(scenario.spikes.size, `seed ${seed}`).toBeGreaterThan(0);
      expect(Math.abs(run.distance / scenario.truth.distance - 1), `seed ${seed}`).toBeLessThanOrEqual(0.025);
      expect(run.retained.filter((verdict) => scenario.spikes.has(verdict.fix.t)), `seed ${seed}`).toEqual([]);
    }
  });

  it("flat-noise keeps the GNSS-only ascent under 30 m (ELE-010)", () => {
    for (const seed of seeds) {
      const run = runStages(stageScenarios.flatNoise(seed));
      expect(run.ascent, `seed ${seed}`).toBeLessThanOrEqual(30);
    }
  });

  it("sawtooth counts 500 m of ascent within 2 % with the barometer (ELE-002, ELE-010)", () => {
    for (const seed of seeds) {
      const run = runStages(stageScenarios.sawtooth(seed));
      expect(Math.abs(run.ascent - 500), `seed ${seed}`).toBeLessThanOrEqual(10);
      expect(Math.abs(run.descent - 500), `seed ${seed}`).toBeLessThanOrEqual(10);
    }
  });

  it("steep-climb never auto-pauses on a vertical kilometer (GPS-033)", () => {
    for (const seed of seeds) {
      const run = runStages(stageScenarios.steepClimb(seed));
      const firstMoving = run.moving.indexOf(1);
      expect(firstMoving, `seed ${seed}`).toBeGreaterThanOrEqual(0);
      expect(firstMoving, `seed ${seed}`).toBeLessThan(15);
      expect(run.moving.subarray(firstMoving).includes(0), `seed ${seed}`).toBe(false);
    }
  });

  it("bike-descent rejects no valid fix at 70 km/h", () => {
    for (const seed of seeds) {
      const scenario = stageScenarios.bikeDescent(seed);
      const run = runStages(scenario);
      expect(run.gateRejections, `seed ${seed}`).toEqual({});
      expect(run.rejections, `seed ${seed}`).toEqual({});
      expect(Math.abs(run.distance / scenario.truth.distance - 1), `seed ${seed}`).toBeLessThan(0.01);
    }
  });

  it("android-ellipsoid corrects ellipsoidal heights to within 2 m (ELE-001)", () => {
    for (const seed of seeds) {
      const scenario = stageScenarios.androidEllipsoid(seed);
      expect(scenario.samples.every((sample) => sample.type !== "fix" || sample.altitudeMslMm === null)).toBe(true);
      const run = runStages(scenario);
      let bias = 0;
      run.retained.forEach((verdict, index) => (bias += (run.altitude[index] ?? 0) - (scenario.truth.altitude[truthAt(scenario, verdict.fix)] ?? 0)));
      expect(Math.abs(bias / run.retained.length), `seed ${seed}`).toBeLessThanOrEqual(2);
      expect(grenobleUndulation).toBeGreaterThan(40);
    }
  });

  it("simulated-fixes are accepted and mark the activity (GPS-020)", () => {
    const scenario = stageScenarios.simulatedFixes(1);
    const run = runStages(scenario);
    expect(run.simulated).toBe(true);
    expect(run.retained.length).toBeGreaterThan(250);
    expect(runStages(stageScenarios.flatNoise(1)).simulated).toBe(false);
  });
});
