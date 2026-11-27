import { describe, expect, it } from "vitest";
import type { EpochMs, Id, Segment } from "@obnixe/schema";
import type { Environment } from "../database.ts";
import type { ProcessedTrack } from "./batch.ts";
import { candidateShapes, newSegment, segmentPasses, segmentShape } from "./segments.ts";
import { locate } from "./stages/derive.ts";
import { mountainOuting } from "./testing/scenarios.ts";
import { runBatch } from "./testing/run.ts";

let ids = 0;
const env: Environment = { now: () => 1_780_000_000_000 as EpochMs, newId: () => `segment-${++ids}` as Id };

/** The trail segment drawn over `[fromMeters, toMeters]` of the activity's distance. */
function drawn(processed: ProcessedTrack, fromMeters: number, toMeters: number): Segment {
  const { distance } = processed.series;
  const range = { from: locate(distance, fromMeters), to: locate(distance, toMeters) };
  const plan = newSegment(env, processed.series, processed.summary.ascentMm !== null, { name: "Montée", sport: "trail", sessionId: "session" as Id, range });
  if (plan.mutation.kind !== "insert" || plan.mutation.table !== "segment") throw new Error("Not a segment insert");
  const { row } = plan.mutation;
  return { ...row, sourceSessionId: row.sourceSessionId ?? null, deletedAt: null, createdAt: env.now(), updatedAt: env.now() };
}

// The package's test script runs this file apart from the coverage run: instrumentation triples the detection time.
describe("segment detection budget (SEG-005)", () => {
  it("matches a 3 h outing against 200 segments within 50 ms", () => {
    const processed = runBatch(mountainOuting(3, 1));
    const total = processed.series.distance.at(-1) ?? 0;
    const rows = Array.from({ length: 200 }, (_, index) => {
      const from = ((index * 137) % 190) * (total / 200);
      return drawn(processed, from, from + 300 + (index % 7) * 400);
    });
    let fastest = Number.POSITIVE_INFINITY;
    let found = 0;
    for (let attempt = 0; attempt < 10 && fastest > 50; attempt += 1) {
      const started = performance.now();
      const shapes = candidateShapes(rows.map(segmentShape), "trail", processed.summary.bbox);
      found = segmentPasses(processed, shapes).length;
      fastest = Math.min(fastest, performance.now() - started);
    }
    expect(found).toBeGreaterThanOrEqual(200);
    expect(fastest).toBeLessThanOrEqual(50);
  }, 60_000);
});
