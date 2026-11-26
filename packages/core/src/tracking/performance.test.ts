import { describe, expect, it } from "vitest";
import { processTrack } from "./batch.ts";
import type { Track } from "./codec/track.ts";
import { demCorrectionZoom, DemTiles, demTileSize, demTilesFor, sampleTerrarium } from "./dem.ts";
import { mountainOuting } from "./testing/scenarios.ts";
import type { Scenario } from "./testing/scenarios.ts";
import { fixesOf, percentile, profileOf, recordedLaps, routeOfTruth, runLive, trackOf, untrimmed } from "./testing/run.ts";

/** Node timings guard against regressions; the budgets themselves bind on the reference phone (`PLT-030`). */
const budgetMs = { liveSampleP95: 0.5, batch3h: 600, batch6h: 800, demCorrection6h: 1200 } as const;
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

  it("stays within the live budget while following the route of the outing (RTE-007, PRF-010)", () => {
    const route = routeOfTruth(threeHours.truth);
    let best = Number.POSITIVE_INFINITY;
    for (let attempt = 0; attempt < attempts; attempt += 1) best = Math.min(best, percentile(runLive(threeHours, [], null, route).timings, 0.95));
    expect(best).toBeLessThanOrEqual(budgetMs.liveSampleP95);
  }, 60_000);

  it("summarizes a 3 h outing of 10 800 fixes within 600 ms (PRF-020)", () => {
    expect(Math.abs(fixesOf(threeHours.samples).length - 10_800)).toBeLessThan(100);
    expect(fastestBatchMs(threeHours)).toBeLessThanOrEqual(budgetMs.batch3h);
  }, 60_000);

  it("processes a 6 h outing within 800 ms (PRF-021)", () => {
    expect(fastestBatchMs(mountainOuting(6, 2))).toBeLessThanOrEqual(budgetMs.batch6h);
  }, 60_000);

  it("samples the DEM under a 6 h outing and measures it again within 1.2 s, tiles decoded (ELE-003)", () => {
    const outing = mountainOuting(6, 2);
    const track = trackOf(outing.samples, [{ kind: "start", t: 0 }]);
    const { fixes } = track.samples;
    const keys = demTilesFor(fixes.latitudeE7, fixes.longitudeE7, demCorrectionZoom);
    const tiles = new DemTiles(
      demCorrectionZoom,
      keys.map((key) => ({ key, elevation: Float32Array.from({ length: demTileSize * demTileSize }, (_, index) => 900 + (index % demTileSize) * 0.4 + Math.floor(index / demTileSize) * 0.2) })),
    );
    const profile = profileOf(outing);
    let fastest = Number.POSITIVE_INFINITY;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const started = performance.now();
      const terrain = sampleTerrarium(fixes, tiles);
      if (terrain === null) throw new Error("Missing tile");
      const corrected: Track = { ...track, samples: { ...track.samples, terrain } };
      expect(processTrack(corrected, profile, { laps: recordedLaps, trim: untrimmed }).summary.elevationSource).toBe("dem");
      fastest = Math.min(fastest, performance.now() - started);
    }
    expect(fastest).toBeLessThanOrEqual(budgetMs.demCorrection6h);
  }, 60_000);

  it("PRF-030 grows linearly with the outing in batch mode and stays flat per sample in stream mode", () => {
    const oneHour = mountainOuting(1, 3);
    const fourHours = mountainOuting(4, 3);
    fastestBatchMs(oneHour);
    expect(fastestBatchMs(fourHours) / fastestBatchMs(oneHour)).toBeLessThan(8);
    const timings = runLive(fourHours).timings;
    const quarter = Math.floor(timings.length / 4);
    const early = percentile(timings.subarray(quarter, 2 * quarter), 0.5);
    const late = percentile(timings.subarray(3 * quarter), 0.5);
    expect(late).toBeLessThan(3 * early + 0.01);
  }, 60_000);
});
