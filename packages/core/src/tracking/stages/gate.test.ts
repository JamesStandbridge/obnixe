import { describe, expect, it } from "vitest";
import { sports } from "@obnixe/schema";
import type { RecordingProfile } from "@obnixe/schema";
import { fixAt } from "../testing/fixes.ts";
import { FixGate, staleFixAgeMs, warmupWindowMs } from "./gate.ts";
import type { GateDecision } from "./gate.ts";

const profile: RecordingProfile = sports.run.recording ?? sports.hike.recording;

const reasonOf = (decision: GateDecision): string => (decision.accepted ? "accepted" : decision.reason);

describe("FixGate", () => {
  it("rejects fixes without a positive horizontal accuracy", () => {
    const gate = new FixGate(profile);
    expect(reasonOf(gate.push(fixAt(0, 0, 0, { horizontalAccuracyDm: null })))).toBe("no_accuracy");
    expect(reasonOf(gate.push(fixAt(1000, 0, 0, { horizontalAccuracyDm: 0 })))).toBe("no_accuracy");
  });

  it("rejects fixes beyond the profile accuracy gate and stale fixes", () => {
    const gate = new FixGate(profile);
    expect(reasonOf(gate.push(fixAt(0, 0, 0, { horizontalAccuracyDm: profile.accuracyGateDm + 1 })))).toBe("inaccurate");
    expect(reasonOf(gate.push(fixAt(1000, 0, 0, { fixAgeMs: staleFixAgeMs + 1 })))).toBe("stale");
    expect(reasonOf(gate.push(fixAt(2000, 0, 0, { fixAgeMs: staleFixAgeMs })))).toBe("accepted");
    expect(reasonOf(gate.push(fixAt(3000, 0, 0, { horizontalAccuracyDm: profile.accuracyGateDm })))).toBe("accepted");
  });

  it("rejects duplicated and out-of-order fixes by GNSS time", () => {
    const gate = new FixGate(profile);
    expect(reasonOf(gate.push(fixAt(1000, 0, 0)))).toBe("accepted");
    expect(reasonOf(gate.push(fixAt(1500, 0, 0, { fixAgeMs: 500 })))).toBe("duplicate");
    expect(reasonOf(gate.push(fixAt(1800, 3, 0, { fixAgeMs: 900 })))).toBe("unordered");
    expect(reasonOf(gate.push(fixAt(2000, 3, 0)))).toBe("accepted");
  });

  it("accepts simulated fixes and flags them (GPS-020)", () => {
    const decision = new FixGate(profile).push(fixAt(0, 0, 0, { simulated: true }));
    expect(decision).toEqual({ accepted: true, simulated: true, promoted: null });
  });

  it("waits for a fix within 20 m during the warmup", () => {
    const gate = new FixGate(profile);
    expect(reasonOf(gate.push(fixAt(0, 0, 0, { horizontalAccuracyDm: 250 })))).toBe("warmup");
    expect(reasonOf(gate.push(fixAt(1000, 0, 0, { horizontalAccuracyDm: 210 })))).toBe("warmup");
    expect(gate.push(fixAt(2000, 0, 0, { horizontalAccuracyDm: 120 }))).toEqual({ accepted: true, simulated: false, promoted: null });
    expect(reasonOf(gate.push(fixAt(3000, 0, 0, { horizontalAccuracyDm: 250 })))).toBe("accepted");
  });

  it("promotes the latest best warmup fix when the window closes without a fix within 20 m", () => {
    const gate = new FixGate(profile);
    const best = fixAt(20_000, 0, 0, { horizontalAccuracyDm: 220 });
    for (const fix of [fixAt(0, 0, 0, { horizontalAccuracyDm: 280 }), fixAt(10_000, 0, 0, { horizontalAccuracyDm: 220 }), best, fixAt(30_000, 0, 0, { horizontalAccuracyDm: 260 })]) {
      expect(reasonOf(gate.push(fix))).toBe("warmup");
    }
    expect(gate.push(fixAt(warmupWindowMs, 0, 0, { horizontalAccuracyDm: 250 }))).toEqual({ accepted: true, simulated: false, promoted: best });
  });

  it("rejects the closing fix as unordered when it is not newer than the promoted one", () => {
    const gate = new FixGate(profile);
    gate.push(fixAt(0, 0, 0, { horizontalAccuracyDm: 280 }));
    const best = fixAt(warmupWindowMs - 1, 0, 0, { horizontalAccuracyDm: 220 });
    gate.push(best);
    expect(gate.push(fixAt(warmupWindowMs + 500, 1, 0, { horizontalAccuracyDm: 250, fixAgeMs: 600 }))).toEqual({ accepted: false, reason: "unordered", promoted: best });
    expect(reasonOf(gate.push(fixAt(warmupWindowMs + 1000, 2, 0)))).toBe("accepted");
  });
});
