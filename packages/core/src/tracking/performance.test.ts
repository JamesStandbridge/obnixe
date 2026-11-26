import { describe, expect, it } from "vitest";
import { processTrack } from "./batch.ts";
import { mountainOuting } from "./testing/scenarios.ts";
import type { Scenario } from "./testing/scenarios.ts";
import { fixesOf, percentile, profileOf, recordedLaps, runLive, trackOf, untrimmed } from "./testing/run.ts";

/** Node timings guard against regressions; the budgets themselves bind on the reference phone (`PLT-030`). */
const budgetMs = { liveSampleP95: 0.5, batch3h: 600, batch6h: 800 } as const;
const attempts = 3;

function fastestBatchMs(scenario: Scenario): number {
  const track = trackOf(scenario.samples, [{ kind: "start", t: 0 }]);
  const profile = profileOf(scenario);
  let fastest = Number.POSITIVE_INFINITY;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const started = performance.now();
    processTrack(track, profile, { laps: recordedLaps, trim: untrimmed });
    fastest = Math.min(fastest, performance.now() - started);
  }
  return fastest;
}

describe("performance budgets", () => {
  const threeHours = mountainOuting(3, 1);

  it("processes a live sample within 0.5 ms at the 95th percentile (PRF-010)", () => {
    let best = Number.POSITIVE_INFINITY;
    for (let attempt = 0; attempt < attempts; attempt += 1) best = Math.min(best, percentile(runLive(threeHours).timings, 0.95));
    expect(best).toBeLessThanOrEqual(budgetMs.liveSampleP95);
  }, 60_000);

  it("summarizes a 3 h outing of 10 800 fixes within 600 ms (PRF-020)", () => {
    expect(Math.abs(fixesOf(threeHours.samples).length - 10_800)).toBeLessThan(100);
    expect(fastestBatchMs(threeHours)).toBeLessThanOrEqual(budgetMs.batch3h);
  }, 60_000);

  it("processes a 6 h outing within 800 ms (PRF-021)", () => {
    expect(fastestBatchMs(mountainOuting(6, 2))).toBeLessThanOrEqual(budgetMs.batch6h);
  }, 60_000);
});
