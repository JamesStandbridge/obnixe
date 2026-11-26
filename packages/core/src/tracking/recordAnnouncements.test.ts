import { beforeEach, describe, expect, it } from "vitest";
import { bestEffort } from "@obnixe/schema";
import type { BestEffortKey, EpochMs, Id } from "@obnixe/schema";
import { fixtures } from "../data/testFixtures.ts";
import type { Fixtures } from "../data/testFixtures.ts";
import { createTestContext } from "../testing.ts";
import type { TestContext } from "../testing.ts";
import { recordAnnouncements } from "./recordAnnouncements.ts";

let context: TestContext;
let make: Fixtures;
let day = 0;

beforeEach(() => {
  context = createTestContext();
  make = fixtures(context);
  day = 0;
});

interface Effort {
  readonly key: BestEffortKey;
  readonly elapsedMs: number;
  readonly ascentMm?: number;
}

function outing(efforts: readonly Effort[], status: "completed" | "in_progress" = "completed"): Id {
  day += 1;
  const startedAt = (Date.UTC(2026, 9, day, 7) as EpochMs);
  const row = make.session({ sport: "run", startedAt, endedAt: status === "completed" ? ((startedAt + 3_600_000) as EpochMs) : null, status });
  make.write([{ kind: "insert", table: "session", row }]);
  for (const effort of efforts) {
    context.db
      .insert(bestEffort)
      .values({ sessionId: row.id, effort: effort.key, elapsedMs: effort.elapsedMs, movingMs: effort.elapsedMs, startOffsetMs: 0, ascentMm: effort.ascentMm ?? null, algorithmVersion: 1 })
      .run();
  }
  return row.id;
}

describe("record announcements", () => {
  it("announces a new record with the beaten one, then the second and third best (PR-004)", () => {
    outing([{ key: "run:distance:10000", elapsedMs: 2_690_000 }, { key: "run:distance:5000", elapsedMs: 1_250_000 }]);
    outing([{ key: "run:distance:10000", elapsedMs: 2_710_000 }, { key: "run:distance:5000", elapsedMs: 1_300_000 }]);
    outing([{ key: "run:distance:5000", elapsedMs: 1_320_000 }]);
    const saved = outing([
      { key: "run:distance:10000", elapsedMs: 2_652_000 },
      { key: "run:distance:5000", elapsedMs: 1_290_000 },
      { key: "run:distance:1000", elapsedMs: 240_000 },
    ]);
    expect(recordAnnouncements(context.db, saved)).toEqual([
      { effort: "run:distance:1000", rank: 1, elapsedMs: 240_000, ascentMm: null, best: null },
      { effort: "run:distance:5000", rank: 2, elapsedMs: 1_290_000, ascentMm: null, best: { elapsedMs: 1_250_000, ascentMm: null } },
      { effort: "run:distance:10000", rank: 1, elapsedMs: 2_652_000, ascentMm: null, best: { elapsedMs: 2_690_000, ascentMm: null } },
    ]);
  });

  it("ranks the ascent window by the highest ascent and leaves the podium out", () => {
    outing([{ key: "trail:ascent_1h", elapsedMs: 3_600_000, ascentMm: 900_000 }]);
    outing([{ key: "trail:ascent_1h", elapsedMs: 3_600_000, ascentMm: 850_000 }]);
    outing([{ key: "trail:ascent_1h", elapsedMs: 3_600_000, ascentMm: 800_000 }]);
    const fourth = outing([{ key: "trail:ascent_1h", elapsedMs: 3_600_000, ascentMm: 700_000 }]);
    const best = outing([{ key: "trail:ascent_1h", elapsedMs: 3_600_000, ascentMm: 950_000 }]);
    expect(recordAnnouncements(context.db, fourth)).toEqual([]);
    expect(recordAnnouncements(context.db, best)).toEqual([{ effort: "trail:ascent_1h", rank: 1, elapsedMs: 3_600_000, ascentMm: 950_000, best: { elapsedMs: 3_600_000, ascentMm: 900_000 } }]);
  });

  it("gives a tie to the earlier activity and ignores deleted and open sessions", () => {
    const deleted = outing([{ key: "run:distance:5000", elapsedMs: 1_100_000 }]);
    make.write([{ kind: "update", table: "session", key: deleted, patch: { deletedAt: Date.UTC(2026, 9, 20) as EpochMs } }]);
    outing([{ key: "run:distance:5000", elapsedMs: 1_000_000 }], "in_progress");
    outing([{ key: "run:distance:5000", elapsedMs: 1_250_000 }]);
    const saved = outing([{ key: "run:distance:5000", elapsedMs: 1_250_000 }]);
    expect(recordAnnouncements(context.db, saved)).toEqual([{ effort: "run:distance:5000", rank: 2, elapsedMs: 1_250_000, ascentMm: null, best: { elapsedMs: 1_250_000, ascentMm: null } }]);
  });
});
