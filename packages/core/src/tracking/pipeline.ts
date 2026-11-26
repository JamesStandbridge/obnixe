import type { RecordingProfile } from "@obnixe/schema";
import { BarometricFusion, orthometricAltitude, verticalSigma } from "./stages/altitude.ts";
import { FixGate } from "./stages/gate.ts";
import { KalmanTrace, PlanarKalman } from "./stages/kalman.ts";
import type { KalmanEstimate } from "./stages/kalman.ts";
import { CadenceMeter } from "./stages/motion.ts";
import { OutlierRejector } from "./stages/reject.ts";
import type { PositionVerdict } from "./stages/reject.ts";
import type { Fix, PressureSample, StepSample } from "./types.ts";

/** A fix retained by the stages 2 to 4, with the context captured when the gate accepted it. */
export interface SettledFix {
  readonly fix: Fix;
  /** Caller's identifier of the fix: its index in the input columns in batch mode. */
  readonly tag: number;
  readonly estimate: KalmanEstimate;
  /** The filter restarted on this fix: the segment from the previous one is a gap (`GPS-030`). */
  readonly reset: boolean;
  /** Orthometric GNSS altitude of the fix (`ELE-001`). */
  readonly gnssAltitude: number | null;
  /** Fused altitude when the fix arrived, `null` before the first pressure sample. */
  readonly fusedAltitude: number | null;
  /** Index of the fused altitude in `BarometricFusion.smoothRts()`, -1 without one. */
  readonly fusedIndex: number;
  /** Steps per minute when the fix arrived, `null` without pedometer. */
  readonly cadence: number | null;
}

interface PendingContext {
  readonly tag: number;
  readonly gnssAltitude: number | null;
  readonly fusedAltitude: number | null;
  readonly fusedIndex: number;
  readonly cadence: number | null;
}

export interface PipelineOptions {
  /** Keeps the fused altitudes for `BarometricFusion.smoothRts`, in batch mode. */
  readonly altitudeSmoothing: boolean;
}

/**
 * Stages 2 to 4 with the altitude fusion and the cadence, shared by the live tracker and the batch processing: the gate and
 * its promoted warmup fix, the outlier rejection whose verdicts lag one fix, the Kalman filter recording its trace for the
 * backward pass. Each settled fix is the latest step of the trace.
 */
export class SignalPipeline {
  readonly fusion: BarometricFusion;
  readonly trace = new KalmanTrace();
  private readonly altitudeSmoothing: boolean;
  private readonly gate: FixGate;
  private readonly rejector: OutlierRejector;
  private readonly cadenceMeter = new CadenceMeter();
  private readonly pending: PendingContext[] = [];
  private readonly warmupTags = new Map<Fix, number>();
  private pendingHead = 0;
  private fusedCount = 0;
  private pressureSeen = false;
  private stepsSeen = false;
  simulated = false;
  gateRejections = 0;
  outlierRejections = 0;

  constructor(profile: RecordingProfile, options: PipelineOptions) {
    this.altitudeSmoothing = options.altitudeSmoothing;
    this.gate = new FixGate(profile);
    this.rejector = new OutlierRejector(profile, new PlanarKalman(profile, this.trace));
    this.fusion = new BarometricFusion({ smoothing: options.altitudeSmoothing });
  }

  get hasBarometer(): boolean {
    return this.pressureSeen;
  }

  get hasPedometer(): boolean {
    return this.stepsSeen;
  }

  pushPressure(sample: PressureSample): void {
    this.pressureSeen = true;
    this.fusion.pushPressure(sample);
  }

  pushSteps(sample: StepSample): void {
    this.stepsSeen = true;
    this.cadenceMeter.push(sample);
  }

  /** Steps per minute at `t`, `null` without pedometer; `t` must not decrease. */
  cadenceAt(t: number): number | null {
    return this.cadenceMeter.at(t);
  }

  /** Gates a fix and returns the fixes retained by the verdicts it settles, oldest first. */
  pushFix(fix: Fix, tag: number): readonly SettledFix[] {
    const decision = this.gate.push(fix);
    if (!decision.accepted) {
      this.gateRejections += 1;
      if (decision.reason === "warmup") this.warmupTags.set(fix, tag);
    }
    if (decision.promoted === null && !decision.accepted) return [];
    const settled: SettledFix[] = [];
    if (decision.promoted !== null) {
      this.gateRejections -= 1;
      this.accept(decision.promoted, this.warmupTags.get(decision.promoted) ?? -1, settled);
    }
    this.warmupTags.clear();
    if (decision.accepted) this.accept(fix, tag, settled);
    return settled;
  }

  /** Settles the last fix, at the end of the track. */
  flush(): readonly SettledFix[] {
    const settled: SettledFix[] = [];
    this.collect(this.rejector.flush(), settled);
    return settled;
  }

  private accept(fix: Fix, tag: number, settled: SettledFix[]): void {
    this.simulated ||= fix.simulated;
    const gnssAltitude = orthometricAltitude(fix);
    const fusedAltitude = gnssAltitude === null ? null : this.fusion.pushGnss(fix.t, gnssAltitude, verticalSigma(fix));
    const fusedIndex = fusedAltitude === null || !this.altitudeSmoothing ? -1 : this.fusedCount++;
    this.pending.push({ tag, gnssAltitude, fusedAltitude, fusedIndex, cadence: this.cadenceMeter.at(fix.t) });
    this.collect(this.rejector.push(fix), settled);
  }

  private collect(verdicts: readonly PositionVerdict[], settled: SettledFix[]): void {
    for (const verdict of verdicts) {
      const context = this.pending[this.pendingHead];
      this.pendingHead += 1;
      if (context === undefined) throw new Error("Outlier verdicts outnumber the accepted fixes");
      if (verdict.retained) settled.push({ fix: verdict.fix, estimate: verdict.estimate, reset: verdict.reset, ...context });
      else this.outlierRejections += 1;
    }
    if (this.pendingHead > 64 && this.pendingHead * 2 > this.pending.length) {
      this.pending.splice(0, this.pendingHead);
      this.pendingHead = 0;
    }
  }
}
