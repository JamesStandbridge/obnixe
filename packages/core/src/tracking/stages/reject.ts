import type { RecordingProfile } from "@obnixe/schema";
import { ellipsoidDistance } from "../geo.ts";
import type { Fix } from "../types.ts";
import { observeFix } from "./kalman.ts";
import type { KalmanEstimate, PlanarKalman, PositionObservation } from "./kalman.ts";

export const recoveryRejections = 5;
export const recoveryTimeoutMs = 15_000;
/** Slack in m/s added to the plausible change of Doppler speed (rule 2). */
export const accelerationSlack = 2;

export type RejectReason = "speed" | "acceleration" | "spike" | "innovation";

/** `reset` marks a filter restart: the first fix, or a recovery whose connecting segment is a gap (`GPS-030`). */
export type PositionVerdict =
  | { readonly fix: Fix; readonly retained: true; readonly estimate: KalmanEstimate; readonly reset: boolean }
  | { readonly fix: Fix; readonly retained: false; readonly reason: RejectReason };

interface Candidate {
  readonly fix: Fix;
  readonly observation: PositionObservation;
}

const distance = (from: PositionObservation, to: PositionObservation): number => ellipsoidDistance(from.latitude, from.longitude, to.latitude, to.longitude);

/**
 * Stage 3, driving the filter of stage 4: rules 1 (speed) and 2 (acceleration) against the last retained fix, rule 3 (spike)
 * with one fix of lookahead, rule 4 (innovation) in the filter, then recovery after a series of rejections (`GPS-030`).
 * A fix is settled when the next one arrives or on `flush`, so verdicts lag by one fix.
 */
export class OutlierRejector {
  private readonly maxSpeed: number;
  private readonly maxAcceleration: number;
  private readonly filter: PlanarKalman;
  private anchor: PositionObservation | null = null;
  private pending: Candidate | null = null;
  private consecutiveRejections = 0;

  constructor(profile: RecordingProfile, filter: PlanarKalman) {
    this.maxSpeed = profile.maxSpeedMmS / 1000;
    this.maxAcceleration = profile.maxAccelerationMmS2 / 1000;
    this.filter = filter;
  }

  /** Takes a fix accepted by the gate and returns the verdicts settled by it, oldest first. */
  push(fix: Fix): readonly PositionVerdict[] {
    const candidate: Candidate = { fix, observation: observeFix(fix) };
    const verdicts: PositionVerdict[] = [];
    if (this.pending !== null) {
      verdicts.push(this.settle(this.pending, candidate.observation));
      this.pending = null;
    }
    const reason = this.kinematicRejection(candidate.observation);
    if (reason === null) this.pending = candidate;
    else verdicts.push(this.reject(candidate, reason));
    return verdicts;
  }

  /** Settles the fix waiting for its lookahead, at the end of the track. */
  flush(): readonly PositionVerdict[] {
    if (this.pending === null) return [];
    const verdict = this.settle(this.pending, null);
    this.pending = null;
    return [verdict];
  }

  private kinematicRejection(observation: PositionObservation): "speed" | "acceleration" | null {
    const anchor = this.anchor;
    if (anchor === null) return null;
    const dt = Math.max(observation.t - anchor.t, 0) / 1000;
    if (distance(anchor, observation) > this.maxSpeed * dt + 2 * (anchor.accuracy + observation.accuracy)) return "speed";
    if (anchor.speed !== null && observation.speed !== null && Math.abs(observation.speed - anchor.speed) > this.maxAcceleration * dt + accelerationSlack) return "acceleration";
    return null;
  }

  private settle(candidate: Candidate, lookahead: PositionObservation | null): PositionVerdict {
    const anchor = this.anchor;
    const observation = candidate.observation;
    if (anchor === null) return this.restart(candidate);
    if (lookahead !== null) {
      const ab = distance(anchor, observation);
      if (ab + distance(observation, lookahead) > 3 * distance(anchor, lookahead) + 4 * observation.accuracy && ab > 2 * (anchor.accuracy + observation.accuracy)) {
        return { fix: candidate.fix, retained: false, reason: "spike" };
      }
    }
    const estimate = this.filter.update(observation);
    if (estimate === null) return this.reject(candidate, "innovation");
    this.anchor = observation;
    this.consecutiveRejections = 0;
    return { fix: candidate.fix, retained: true, estimate, reset: false };
  }

  private reject(candidate: Candidate, reason: Exclude<RejectReason, "spike">): PositionVerdict {
    this.consecutiveRejections += 1;
    const silence = this.anchor === null ? 0 : candidate.observation.t - this.anchor.t;
    if (this.consecutiveRejections >= recoveryRejections || silence > recoveryTimeoutMs) return this.restart(candidate);
    return { fix: candidate.fix, retained: false, reason };
  }

  private restart(candidate: Candidate): PositionVerdict {
    this.anchor = candidate.observation;
    this.consecutiveRejections = 0;
    return { fix: candidate.fix, retained: true, estimate: this.filter.reset(candidate.observation), reset: true };
  }
}
