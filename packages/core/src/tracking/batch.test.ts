import { describe, expect, it } from "vitest";
import { processTrack } from "./batch.ts";
import { estimateEnergy } from "./energy.ts";
import { ellipsoidDistance } from "./geo.ts";
import { sessionValuesFromRecording } from "./summary.ts";
import { coreScenarios, stageScenarios } from "./testing/scenarios.ts";
import { fixesOf, profileOf, recordedLaps, runBatch, trackOf, untrimmed } from "./testing/run.ts";
import { trackingAlgorithmVersion } from "./version.ts";

describe("processTrack (GPS-001, GPS-002)", () => {
  it("is deterministic and versioned", () => {
    const scenario = coreScenarios.stopAndGo(1);
    const first = runBatch(scenario);
    expect(runBatch(scenario)).toEqual(first);
    expect(first.algorithmVersion).toBe(trackingAlgorithmVersion);
    expect(first.summary.algorithmVersion).toBe(trackingAlgorithmVersion);
  });

  it("fills the recording columns", () => {
    const scenario = stageScenarios.sawtooth(1);
    const { summary, series } = runBatch(scenario);
    expect(summary.elapsedMs).toBe(scenario.truth.t.at(-1));
    expect(summary.movingMs).toBeLessThanOrEqual(summary.elapsedMs);
    expect(summary.pointCount).toBe(fixesOf(scenario.samples).length);
    expect(summary.elevationSource).toBe("barometer");
    expect(summary.cadenceSource).toBe("pedometer");
    expect(summary.heartRateSource).toBe("none");
    expect(summary.heartRateAvg).toBeNull();
    expect(summary.cadenceAvg).toBeGreaterThan(95);
    expect(summary.cadenceAvg).toBeLessThan(105);
    expect(summary.goodFixPermille).toBe(1000);
    expect(summary.altitudeMaxMm! - summary.altitudeMinMm!).toBeGreaterThan(45_000);
    expect(summary.speedMaxMmS).toBeGreaterThan(2400);
    expect(summary.speedMaxMmS).toBeLessThan(3200);
    expect(summary.bbox?.south).toBeLessThan(summary.bbox?.north ?? 0);
    expect(series.distance.at(-1)).toBeCloseTo(summary.distanceMm / 1000, 2);
  });

  it("keeps each retained fix's input index for exports at the original instants (IO-002)", () => {
    const scenario = stageScenarios.urbanCanyon(2);
    const { series, details } = runBatch(scenario);
    const fixes = fixesOf(scenario.samples);
    expect(series.length + details.outlierRejections + details.gateRejections).toBe(fixes.length);
    for (let index = 0; index < series.length; index += 25) {
      const fix = fixes[series.fixIndex[index] ?? 0];
      expect(fix?.t).toBe(series.t[index]);
      expect(ellipsoidDistance(series.latitude[index] ?? 0, series.longitude[index] ?? 0, (fix?.latitudeE7 ?? 0) / 1e7, (fix?.longitudeE7 ?? 0) / 1e7)).toBeLessThan(100);
    }
  });

  it("excludes manual pauses from moving time and distance (GPS-033)", () => {
    const scenario = coreScenarios.steadyRun(1);
    const plain = runBatch(scenario);
    const paused = runBatch(scenario, [
      { kind: "start", t: 0 },
      { kind: "pause", t: 600_000 },
      { kind: "resume", t: 900_000 },
    ]);
    expect(paused.pauses).toEqual([{ startMs: 600_000, endMs: 900_000 }]);
    expect(plain.summary.movingMs - paused.summary.movingMs).toBeGreaterThan(299_000);
    expect(plain.summary.movingMs - paused.summary.movingMs).toBeLessThan(302_000);
    expect(paused.intervals.find((interval) => interval.kind === "paused")).toMatchObject({ startMs: 600_000, endMs: 900_000 });
    expect(paused.summary.elapsedMs).toBe(plain.summary.elapsedMs);
  });

  it("measures only the trimmed window and counts offsets from its start (SUM-004)", () => {
    const scenario = coreScenarios.steadyRun(2);
    const profile = profileOf(scenario);
    const trimmed = processTrack(trackOf(scenario.samples), profile, { laps: recordedLaps, trim: { startMs: 600_000, endMs: 1_800_000 } });
    expect(trimmed.elapsed).toEqual({ startMs: 600_000, endMs: 1_800_000 });
    expect(trimmed.summary.elapsedMs).toBe(1_200_000);
    expect(trimmed.summary.distanceMm / 1000).toBeGreaterThan(3950);
    expect(trimmed.summary.distanceMm / 1000).toBeLessThan(4050);
    expect(trimmed.laps.map((lap) => lap.bounds)).toEqual([{ trigger: "manual", startOffsetMs: 0, endOffsetMs: 1_200_000, workoutStep: null }]);
    for (const effort of trimmed.bestEfforts) expect(effort.startOffsetMs + effort.elapsedMs).toBeLessThanOrEqual(1_200_000);
  });

  it("re-measures given laps and records automatic ones (REC-041)", () => {
    const scenario = coreScenarios.steadyRun(3);
    const profile = profileOf(scenario);
    const track = trackOf(scenario.samples, [{ kind: "start", t: 0 }, { kind: "lap", t: 500_000 }]);
    const auto = processTrack(track, profile, { laps: { kind: "recorded", autoLap: { trigger: "distance", meters: 2000 } }, trim: untrimmed });
    expect(auto.laps.map((lap) => lap.bounds.trigger)).toEqual(["manual", "distance", "distance", "distance", "distance", "distance"]);
    expect(auto.laps.slice(1, -1).every((lap) => Math.abs(lap.distanceMm - 2_000_000) <= 3)).toBe(true);
    expect(auto.laps.reduce((total, lap) => total + lap.elapsedMs, 0)).toBe(auto.summary.elapsedMs);
    const given = processTrack(track, profile, { laps: { kind: "given", laps: auto.laps.map((lap) => lap.bounds) }, trim: untrimmed });
    expect(given.laps).toEqual(auto.laps);
  });

  it("produces splits, best efforts with their keys, and the inputs of the energy estimate", () => {
    const scenario = coreScenarios.steadyRun(4);
    const processed = runBatch(scenario);
    expect(processed.splits).toHaveLength(10);
    expect(processed.splits.slice(0, 9).every((split) => split.distanceMm === 1_000_000)).toBe(true);
    expect(processed.splits.every((split) => Math.abs(split.movingMs / (split.distanceMm / 1000) - 300) < 6)).toBe(true);
    const covered = profileOf(scenario).bestEffortMeters.filter((meters) => meters * 1000 <= processed.summary.distanceMm);
    expect(covered.slice(0, 4)).toEqual([400, 1000, 1609.344, 5000]);
    expect(processed.bestEfforts.map((effort) => effort.effort)).toEqual(covered.map((meters) => `run:distance:${meters}`));
    expect(processed.bestEfforts.find((effort) => effort.effort === "run:distance:5000")?.elapsedMs).toBeGreaterThan(1_480_000);
    expect(processed.bestEfforts.find((effort) => effort.effort === "run:distance:5000")?.elapsedMs).toBeLessThan(1_520_000);
    expect(processed.details.gradeAdjustedDistanceMm).not.toBeNull();
    const energy = estimateEnergy(
      { sport: "run", values: {}, startedAt: trackOf([]).startedAt, elapsed: processed.elapsed, moving: processed.moving, distanceMm: processed.summary.distanceMm, path: processed.series, heartRate: null },
      { massGrams: 70_000, birthYear: 1990, sex: "male" },
    );
    expect(energy?.method).toBe("mechanical");
    expect(energy?.kcal).toBeGreaterThan(600);
    expect(energy?.kcal).toBeLessThan(900);
  });

  it("handles a track without any fix", () => {
    const processed = processTrack(trackOf([], [{ kind: "start", t: 0 }, { kind: "stop", t: 60_000 }]), profileOf({ sport: "run" }), { laps: recordedLaps, trim: untrimmed });
    expect(processed.summary).toMatchObject({ elapsedMs: 60_000, movingMs: 0, distanceMm: 0, ascentMm: null, elevationSource: "none", bbox: null, speedMaxMmS: null, pointCount: 0 });
    expect(processed.splits).toEqual([]);
    expect(processed.bestEfforts).toEqual([]);
  });
});

describe("session values (SPT-003)", () => {
  it("derive distance, ascent, heart rate and paused seconds from the recording row", () => {
    const recording = { elapsedMs: 3_600_400, movingMs: 3_000_000, distanceMm: 10_000_600, ascentMm: 120_400, heartRateAvg: 151 };
    expect(sessionValuesFromRecording({ kind: "easy", distance: 1, heart_rate_avg: 99 }, recording, profileOf({ sport: "run" }))).toEqual({
      values: { kind: "easy", distance: 10_001, elevation_gain: 120, heart_rate_avg: 151 },
      pausedSeconds: 600,
    });
    expect(sessionValuesFromRecording({ elevation_gain: 3, heart_rate_avg: 99 }, { ...recording, ascentMm: null, heartRateAvg: null }, { metrics: ["distance"] })).toEqual({
      values: { distance: 10_001 },
      pausedSeconds: 600,
    });
  });
});
