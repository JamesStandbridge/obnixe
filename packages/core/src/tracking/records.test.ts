import { beforeEach, describe, expect, it } from "vitest";
import { bestEffort } from "@obnixe/schema";
import type { BestEffortKey, EpochMs, FieldValues, Id, LocalDate, SportKey } from "@obnixe/schema";
import { trashMutation } from "../data/trash.ts";
import { fixtures } from "../data/testFixtures.ts";
import type { Fixtures } from "../data/testFixtures.ts";
import { createTestContext } from "../testing.ts";
import type { TestContext } from "../testing.ts";
import type { NewRow } from "../writer.ts";
import { activityRecords, effortBoards, effortMeters, recordStandings, sessionEffortRanks, sportsWithActivities } from "./records.ts";

let context: TestContext;
let make: Fixtures;

beforeEach(() => {
  context = createTestContext();
  make = fixtures(context);
});

const day = (date: string): EpochMs => Date.parse(`${date}T07:00:00Z`) as EpochMs;

function activity(sport: SportKey, date: string, values: FieldValues = {}, durationSeconds = 3600): Id {
  const row = make.session({ sport, startedAt: day(date), endedAt: (day(date) + durationSeconds * 1000) as EpochMs, localDate: date as LocalDate, values });
  make.write([{ kind: "insert", table: "session", row }]);
  return row.id;
}

function recordingRow(sessionId: Id, overrides: Partial<NewRow<"recording">> = {}): NewRow<"recording"> {
  return {
    id: context.env.newId(),
    sessionId,
    source: "live",
    importFormat: null,
    externalId: null,
    device: "Pixel 9 Pro",
    algorithmVersion: 1,
    autoPause: true,
    elevationSource: "barometer",
    cadenceSource: "none",
    heartRateSource: "none",
    simulated: false,
    trimStartMs: 0,
    trimEndMs: null,
    elapsedMs: 3_700_000,
    movingMs: 3_600_000,
    distanceMm: 10_000_000,
    ascentMm: 100_000,
    descentMm: 100_000,
    altitudeMinMm: 200_000,
    altitudeMaxMm: 300_000,
    speedMaxMmS: null,
    cadenceAvg: null,
    steps: null,
    heartRateAvg: null,
    heartRateMax: null,
    heartRateDevice: null,
    energyKcal: null,
    energyMethod: null,
    importedEnergyKcal: null,
    weather: null,
    goodFixPermille: 900,
    bbox: null,
    previewPolyline: null,
    trackFile: "tracks/a.otrk",
    trackSha256: "0".repeat(64),
    trackBytes: 1000,
    pointCount: 1000,
    ...overrides,
  };
}

function effort(sessionId: Id, key: BestEffortKey, elapsedMs: number, ascentMm: number | null = null): void {
  context.db.insert(bestEffort).values({ sessionId, effort: key, elapsedMs, movingMs: elapsedMs, startOffsetMs: 0, ascentMm, algorithmVersion: 1 }).run();
}

describe("best effort records", () => {
  it("reads the distance of an effort key", () => {
    expect(effortMeters("run:distance:21097.5")).toBe(21097.5);
    expect(effortMeters("trail:ascent_1h")).toBeNull();
  });

  it("ranks the podium, the best of the year and the progression of each effort (PR-005)", () => {
    const first = activity("run", "2025-03-01");
    const second = activity("run", "2025-09-01");
    const third = activity("run", "2026-02-01");
    const fourth = activity("run", "2026-05-01");
    effort(first, "run:distance:5000", 1_500_000);
    effort(second, "run:distance:5000", 1_400_000);
    effort(third, "run:distance:5000", 1_450_000);
    effort(fourth, "run:distance:5000", 1_350_000);
    effort(second, "run:distance:1000", 250_000);
    const [kilometer, five] = effortBoards(context.db, "run", 2026);
    expect(kilometer?.effort).toBe("run:distance:1000");
    expect(five?.podium.map((entry) => entry.sessionId)).toEqual([fourth, second, third]);
    expect(five?.progression.map((entry) => entry.sessionId)).toEqual([first, second, fourth]);
    expect(five?.yearBest?.sessionId).toBe(fourth);
    expect(five?.count).toBe(4);
    expect(effortBoards(context.db, "run", 2024)[1]?.yearBest).toBeNull();
  });

  it("puts the ascent efforts last and ranks them by ascent", () => {
    const low = activity("trail", "2026-01-01");
    const high = activity("trail", "2026-02-01");
    effort(low, "trail:ascent_1h", 3_600_000, 600_000);
    effort(high, "trail:ascent_1h", 3_600_000, 900_000);
    effort(low, "trail:distance:10000", 3_000_000);
    const boards = effortBoards(context.db, "trail", 2026);
    expect(boards.map((board) => board.effort)).toEqual(["trail:distance:10000", "trail:ascent_1h"]);
    expect(boards[1]?.podium.map((entry) => entry.sessionId)).toEqual([high, low]);
  });

  it("drops trashed activities from the records and the badges (PR-003)", () => {
    const old = activity("run", "2026-01-01");
    const fast = activity("run", "2026-02-01");
    effort(old, "run:distance:5000", 1_500_000);
    effort(fast, "run:distance:5000", 1_400_000);
    expect(sessionEffortRanks(context.db, old).get("run:distance:5000")).toEqual({ rank: 2, standing: "former" });
    expect(recordStandings(context.db, ["run:distance:5000"]).get(old)?.get("run:distance:5000")).toBe("former");
    make.write([trashMutation("session", fast, context.env.now())]);
    expect(sessionEffortRanks(context.db, old).get("run:distance:5000")).toEqual({ rank: 1, standing: "current" });
    expect(effortBoards(context.db, "run", 2026)[0]?.podium).toHaveLength(1);
    expect(sessionEffortRanks(context.db, fast).size).toBe(0);
  });
});

describe("activity records", () => {
  it("takes the maxima of recorded and hand-logged activities (PR-005)", () => {
    const logged = activity("run", "2026-01-01", { distance: 21_100, elevation_gain: 50 }, 7200);
    const recorded = activity("run", "2026-02-01", { distance: 10_000 });
    make.write([{ kind: "insert", table: "recording", row: recordingRow(recorded) }]);
    const records = new Map(activityRecords(context.db, "run").map((record) => [record.kind, record]));
    expect(records.get("distance")).toMatchObject({ sessionId: logged, value: 21_100_000 });
    expect(records.get("moving")).toMatchObject({ sessionId: logged, value: 7_200_000 });
    expect(records.get("ascent")).toMatchObject({ sessionId: recorded, value: 100_000 });
    expect(records.get("altitude")).toMatchObject({ sessionId: recorded, value: 300_000 });
    expect(records.has("speed")).toBe(false);
  });

  it("keeps simulated tracks and electric bikes out, and needs 20 km for the bike speed (PR-002)", () => {
    const simulated = activity("run", "2026-01-01");
    make.write([{ kind: "insert", table: "recording", row: recordingRow(simulated, { simulated: true }) }]);
    expect(activityRecords(context.db, "run")).toEqual([]);
    const short = activity("bike", "2026-01-02");
    const long = activity("bike", "2026-01-03");
    const assisted = activity("bike", "2026-01-04", { e_bike: true, distance: 80_000 }, 7200);
    make.write([
      { kind: "insert", table: "recording", row: recordingRow(short, { distanceMm: 15_000_000, movingMs: 1_800_000 }) },
      { kind: "insert", table: "recording", row: recordingRow(long, { distanceMm: 40_000_000, elapsedMs: 5_000_000, movingMs: 4_800_000 }) },
    ]);
    const records = new Map(activityRecords(context.db, "bike").map((record) => [record.kind, record]));
    expect(records.get("speed")).toMatchObject({ sessionId: long, value: (40_000_000 * 1000) / 4_800_000 });
    expect(records.get("distance")?.sessionId).toBe(long);
    expect([...records.values()].some((record) => record.sessionId === assisted)).toBe(false);
  });

  it("offers the sports of the kept activities", () => {
    activity("run", "2026-01-01");
    const trashed = activity("trail", "2026-01-02");
    make.write([trashMutation("session", trashed, context.env.now())]);
    expect([...sportsWithActivities(context.db)]).toEqual(["run"]);
  });
});
