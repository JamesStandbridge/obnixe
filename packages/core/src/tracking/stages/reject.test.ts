import { describe, expect, it } from "vitest";
import { sports } from "@obnixe/schema";
import type { RecordingProfile } from "@obnixe/schema";
import { fixAt } from "../testing/fixes.ts";
import type { Fix } from "../types.ts";
import { PlanarKalman } from "./kalman.ts";
import { OutlierRejector, recoveryRejections, recoveryTimeoutMs } from "./reject.ts";
import type { PositionVerdict } from "./reject.ts";

const profile: RecordingProfile = sports.run.recording ?? sports.hike.recording;

function run(fixes: readonly Fix[]): PositionVerdict[] {
  const rejector = new OutlierRejector(profile, new PlanarKalman(profile));
  return [...fixes.flatMap((fix) => rejector.push(fix)), ...rejector.flush()];
}

const outcome = (verdict: PositionVerdict): string => (verdict.retained ? (verdict.reset ? "reset" : "retained") : verdict.reason);

const walk = (count: number, from: number = 0): Fix[] => Array.from({ length: count }, (_, index) => fixAt((from + index) * 1000, 2 * (from + index), 0, { horizontalAccuracyDm: 30 }));

describe("OutlierRejector", () => {
  it("settles each fix with one fix of lookahead and restarts on the first", () => {
    const rejector = new OutlierRejector(profile, new PlanarKalman(profile));
    const [first, second] = walk(2);
    expect(rejector.push(first ?? fixAt(0, 0, 0))).toEqual([]);
    expect(rejector.push(second ?? fixAt(0, 0, 0)).map(outcome)).toEqual(["reset"]);
    expect(rejector.flush().map(outcome)).toEqual(["retained"]);
    expect(rejector.flush()).toEqual([]);
  });

  it("rejects a jump faster than the profile maximum speed (GPS-030 rule 1)", () => {
    const fixes = [...walk(5), fixAt(5000, 10 + 50, 0, { horizontalAccuracyDm: 30 }), ...walk(3, 6)];
    expect(run(fixes).map(outcome)).toEqual(["reset", "retained", "retained", "retained", "retained", "speed", "retained", "retained", "retained"]);
  });

  it("rejects an implausible change of Doppler speed (GPS-030 rule 2)", () => {
    const fixes = [fixAt(0, 0, 0, { speedCmS: 100, bearingCentiDeg: 9000 }), fixAt(1000, 1, 0, { speedCmS: 1200, bearingCentiDeg: 9000 }), fixAt(2000, 2, 0, { speedCmS: 100, bearingCentiDeg: 9000 })];
    expect(run(fixes).map(outcome)).toEqual(["reset", "acceleration", "retained"]);
  });

  it("rejects an out-and-back spike with the lookahead (GPS-030 rule 3)", () => {
    const fixes = [fixAt(0, 0, 0), fixAt(5000, 5, 50), fixAt(10_000, 15, 0), fixAt(15_000, 22, 0)];
    expect(run(fixes).map(outcome)).toEqual(["reset", "spike", "retained", "retained"]);
  });

  it("recovers after a series of innovation rejections (GPS-030)", () => {
    const shifted = Array.from({ length: 8 }, (_, index) => fixAt((30 + index) * 1000, 2 * (30 + index), 24, { horizontalAccuracyDm: 30 }));
    const outcomes = run([...walk(30), ...shifted]).map(outcome).slice(30);
    const resumed = outcomes.findIndex((value) => value === "retained" || value === "reset");
    expect(outcomes[0]).toBe("innovation");
    expect(resumed).toBeGreaterThan(0);
    expect(resumed).toBeLessThan(recoveryRejections);
    expect(outcomes.slice(resumed + 1).every((value) => value === "retained")).toBe(true);
  });

  it("restarts after the fifth consecutive rejection (GPS-030)", () => {
    const jumps = Array.from({ length: recoveryRejections }, (_, index) => fixAt((10 + index) * 1000, 500, 500, { horizontalAccuracyDm: 30 }));
    const outcomes = run([...walk(10), ...jumps, fixAt(15_000, 502, 500, { horizontalAccuracyDm: 30 })]).map(outcome).slice(10);
    expect(outcomes).toEqual(["speed", "speed", "speed", "speed", "reset", "retained"]);
  });

  it("restarts on the first rejected fix after more than 15 s of silence (GPS-030)", () => {
    const after = 9000 + recoveryTimeoutMs + 1000;
    const outcomes = run([...walk(10), fixAt(after, 2000, 0, { horizontalAccuracyDm: 30 }), fixAt(after + 1000, 2002, 0, { horizontalAccuracyDm: 30 })]).map(outcome).slice(10);
    expect(outcomes).toEqual(["reset", "retained"]);
  });
});
