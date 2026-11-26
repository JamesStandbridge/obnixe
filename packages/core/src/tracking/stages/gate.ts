import type { RecordingProfile } from "@obnixe/schema";
import type { Fix } from "../types.ts";

export const staleFixAgeMs = 10_000;
export const warmupAccuracyDm = 200;
export const warmupWindowMs = 60_000;

export type GateRejection = "no_accuracy" | "inaccurate" | "stale" | "duplicate" | "unordered" | "warmup";
/** `simulated` is the only reason of an accepted fix: it marks the activity (`GPS-020`). */
export type GateReason = GateRejection | "simulated";

/**
 * `promoted` is the best fix of a warmup that found no fix within `warmupAccuracyDm`: it was rejected as `warmup` when it
 * arrived, is accepted when the window closes and must be processed before the fix being gated.
 */
export type GateDecision =
  | { readonly accepted: true; readonly simulated: boolean; readonly promoted: Fix | null }
  | { readonly accepted: false; readonly reason: GateRejection; readonly promoted: Fix | null };

const fixTime = (fix: Fix): number => fix.t - fix.fixAgeMs;

/** Stage 2: validates each fix on its own and against the previous ones, with O(1) state. */
export class FixGate {
  private readonly accuracyGateDm: number;
  private previous: Fix | null = null;
  private lastAcceptedFixTime: number | null = null;
  private warmupStartedAt: number | null = null;
  private warmupBest: Fix | null = null;

  constructor(profile: RecordingProfile) {
    this.accuracyGateDm = profile.accuracyGateDm;
  }

  push(fix: Fix): GateDecision {
    const previous = this.previous;
    this.previous = fix;
    const reason = this.rejection(fix, previous);
    if (reason !== null) return { accepted: false, reason, promoted: null };
    let promoted: Fix | null = null;
    if (this.lastAcceptedFixTime === null) {
      const accuracy = fix.horizontalAccuracyDm ?? 0;
      this.warmupStartedAt ??= fix.t;
      if (accuracy > warmupAccuracyDm) {
        if (this.warmupBest === null || fix.t - this.warmupStartedAt < warmupWindowMs) {
          if (this.warmupBest === null || accuracy <= (this.warmupBest.horizontalAccuracyDm ?? 0)) this.warmupBest = fix;
          return { accepted: false, reason: "warmup", promoted: null };
        }
        promoted = this.warmupBest;
      }
      this.warmupStartedAt = null;
      this.warmupBest = null;
      if (promoted !== null && fixTime(fix) <= fixTime(promoted)) {
        this.lastAcceptedFixTime = fixTime(promoted);
        return { accepted: false, reason: "unordered", promoted };
      }
    }
    this.lastAcceptedFixTime = fixTime(fix);
    return { accepted: true, simulated: fix.simulated, promoted };
  }

  private rejection(fix: Fix, previous: Fix | null): GateRejection | null {
    const accuracy = fix.horizontalAccuracyDm;
    if (accuracy === null || accuracy <= 0) return "no_accuracy";
    if (accuracy > this.accuracyGateDm) return "inaccurate";
    if (fix.fixAgeMs > staleFixAgeMs) return "stale";
    if (previous !== null && fixTime(previous) === fixTime(fix) && previous.latitudeE7 === fix.latitudeE7 && previous.longitudeE7 === fix.longitudeE7) return "duplicate";
    if (this.lastAcceptedFixTime !== null && fixTime(fix) <= this.lastAcceptedFixTime) return "unordered";
    return null;
  }
}
