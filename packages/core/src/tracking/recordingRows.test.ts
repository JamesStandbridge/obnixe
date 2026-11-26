import { beforeEach, describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { sportPreference } from "@obnixe/schema";
import type { EpochMs, Id, RecordingSettings, SportKey } from "@obnixe/schema";
import { fixtures } from "../data/testFixtures.ts";
import type { Fixtures } from "../data/testFixtures.ts";
import { createTestContext } from "../testing.ts";
import type { TestContext } from "../testing.ts";
import { DependentRowsError, LapOutsideRecordingError, UnrecordableSportError } from "../writer.ts";
import type { NewRow } from "../writer.ts";
import { recordingSettingsMutation, recordingSettingsOf } from "./plans.ts";
import { resolveProfile } from "./profile.ts";

let context: TestContext;
let make: Fixtures;

beforeEach(() => {
  context = createTestContext();
  make = fixtures(context);
});

function outing(sport: SportKey, values: NewRow<"session">["values"] = {}): NewRow<"session"> {
  return make.session({ sport, values, endedAt: (context.env.now() + 3_600_000) as EpochMs });
}

function newRecording(sessionId: Id, overrides: Partial<NewRow<"recording">> = {}): NewRow<"recording"> {
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
    cadenceSource: "pedometer",
    heartRateSource: "sensor",
    simulated: false,
    trimStartMs: 0,
    trimEndMs: null,
    elapsedMs: 3_600_000,
    movingMs: 3_400_000,
    distanceMm: 10_000_000,
    ascentMm: 120_000,
    descentMm: 118_000,
    altitudeMinMm: 210_000,
    altitudeMaxMm: 290_000,
    speedMaxMmS: 4100,
    cadenceAvg: 172,
    steps: 9800,
    heartRateAvg: 151,
    heartRateMax: 178,
    heartRateDevice: "Venue 3S",
    energyKcal: null,
    energyMethod: null,
    importedEnergyKcal: null,
    weather: null,
    goodFixPermille: 940,
    bbox: { south: 452_000_000, west: 57_000_000, north: 452_100_000, east: 57_200_000 },
    previewPolyline: null,
    trackFile: null,
    trackSha256: null,
    trackBytes: null,
    pointCount: 3600,
    ...overrides,
  };
}

function newLap(sessionId: Id, position: number, startOffsetMs: number, endOffsetMs: number): NewRow<"lap"> {
  return { id: context.env.newId(), sessionId, position, trigger: "manual", startOffsetMs, endOffsetMs };
}

describe("recording rows", () => {
  it("accepts a live recording with laps on a recordable sport", () => {
    const run = outing("trail", { kind: "training" });
    make.write([
      { kind: "insert", table: "session", row: run },
      { kind: "insert", table: "recording", row: newRecording(run.id) },
      { kind: "insert", table: "lap", row: newLap(run.id, 0, 0, 1_800_000) },
      { kind: "insert", table: "lap", row: newLap(run.id, 1, 1_800_000, 3_600_000) },
    ]);
  });

  it("refuses a live recording on a sport or an option without a profile", () => {
    const swim = outing("swim");
    make.write([{ kind: "insert", table: "session", row: swim }]);
    expect(() => make.write([{ kind: "insert", table: "recording", row: newRecording(swim.id) }])).toThrow(UnrecordableSportError);
    const indoor = outing("bike", { kind: "indoor" });
    make.write([{ kind: "insert", table: "session", row: indoor }]);
    expect(() => make.write([{ kind: "insert", table: "recording", row: newRecording(indoor.id) }])).toThrow(UnrecordableSportError);
  });

  it("lets an import attach a track to a sport without a profile", () => {
    const swim = outing("swim", { water: "open_water" });
    make.write([
      { kind: "insert", table: "session", row: swim },
      { kind: "insert", table: "recording", row: newRecording(swim.id, { source: "import", importFormat: "fit", externalId: "garmin:1234", cadenceSource: "file", heartRateSource: "file", elevationSource: "file" }) },
    ]);
  });

  it("refuses a sport change that leaves a live recording without a profile", () => {
    const ride = outing("bike", { kind: "road" });
    make.write([
      { kind: "insert", table: "session", row: ride },
      { kind: "insert", table: "recording", row: newRecording(ride.id) },
    ]);
    expect(() => make.write([{ kind: "update", table: "session", key: ride.id, patch: { values: { kind: "indoor" } } }])).toThrow(UnrecordableSportError);
    make.write([{ kind: "update", table: "session", key: ride.id, patch: { values: { kind: "gravel", e_bike: true } } }]);
  });

  it("refuses laps outside the recording or without one", () => {
    const run = outing("run", { kind: "easy" });
    make.write([{ kind: "insert", table: "session", row: run }]);
    expect(() => make.write([{ kind: "insert", table: "lap", row: newLap(run.id, 0, 0, 1000) }])).toThrow(LapOutsideRecordingError);
    const recording = newRecording(run.id);
    make.write([{ kind: "insert", table: "recording", row: recording }]);
    expect(() => make.write([{ kind: "insert", table: "lap", row: newLap(run.id, 0, 0, 3_600_001) }])).toThrow(LapOutsideRecordingError);
    make.write([{ kind: "insert", table: "lap", row: newLap(run.id, 0, 0, 3_000_000) }]);
    expect(() => make.write([{ kind: "update", table: "recording", key: recording.id, patch: { elapsedMs: 2_000_000, movingMs: 1_900_000 } }])).toThrow(LapOutsideRecordingError);
  });

  it("validates the JSON columns", () => {
    const run = outing("run");
    make.write([{ kind: "insert", table: "session", row: run }]);
    expect(() => make.write([{ kind: "insert", table: "recording", row: newRecording(run.id, { bbox: { south: 10, west: 0, north: 5, east: 1 } }) }])).toThrow(ZodError);
    expect(() => make.write([{ kind: "insert", table: "recording", row: newRecording(run.id, { trackFile: "tracks/a.otrk", trackSha256: "not a hash", trackBytes: 10 }) }])).toThrow(ZodError);
  });

  it("deletes a session whose derived caches still reference it", () => {
    const run = outing("run");
    make.write([{ kind: "insert", table: "session", row: run }]);
    const client = (context.db as unknown as { $client: { prepare: (statement: string) => { run: (...values: unknown[]) => void } } }).$client;
    client.prepare("INSERT INTO best_effort (session_id, effort, elapsed_ms, moving_ms, start_offset_ms, algorithm_version) VALUES (?, 'run:distance:1000', 240000, 240000, 0, 1)").run(run.id);
    expect(() => make.write([{ kind: "delete", table: "session", key: run.id }])).not.toThrow(DependentRowsError);
  });
});

describe("sport preference recording settings", () => {
  const settings: RecordingSettings = { autoPause: false, autoLap: { trigger: "distance", meters: 1000 }, readout: { main: "distance", secondary: ["moving", "ascent", "vam"] }, alerts: { disabled: ["split"], sound: false, paceRange: { kind: "pace", fastestSecondsPerKm: 300, slowestSecondsPerKm: 360 }, heartRateRange: { lowest: 2, highest: 3 } }, heartRateDevice: { id: "C4:7D:2A:10:9E:01", name: "Venu 3S" } };

  it("accepts settings whose readout uses metrics of the profile", () => {
    make.write([{ kind: "insert", table: "sport_preference", row: { sport: "trail", enabled: true, position: 0, recordingSettings: settings } }]);
  });

  it("refuses metrics the profile does not compute and settings on a sport without a profile", () => {
    expect(() => make.write([{ kind: "insert", table: "sport_preference", row: { sport: "run", enabled: true, position: 0, recordingSettings: settings } }])).toThrow(ZodError);
    expect(() => make.write([{ kind: "insert", table: "sport_preference", row: { sport: "yoga", enabled: true, position: 0, recordingSettings: { ...settings, readout: null } } }])).toThrow(ZodError);
  });

  it("refuses a span that does not follow the sport's primary measure and an inverted one", () => {
    const speed = { ...settings, alerts: { ...settings.alerts, paceRange: { kind: "speed" as const, minMmS: 4000, maxMmS: 6000 } } };
    expect(() => make.write([{ kind: "insert", table: "sport_preference", row: { sport: "trail", enabled: true, position: 0, recordingSettings: speed } }])).toThrow(ZodError);
    expect(() => make.write([{ kind: "insert", table: "sport_preference", row: { sport: "bike", enabled: true, position: 0, recordingSettings: { ...speed, readout: null } } }])).not.toThrow();
    const inverted = { ...settings, alerts: { ...settings.alerts, heartRateRange: { lowest: 4 as const, highest: 2 as const } } };
    expect(() => make.write([{ kind: "insert", table: "sport_preference", row: { sport: "trail", enabled: true, position: 0, recordingSettings: inverted } }])).toThrow(ZodError);
  });

  it("refuses unknown auto lap distances and duplicated metrics", () => {
    expect(() => make.write([{ kind: "insert", table: "sport_preference", row: { sport: "trail", enabled: true, position: 0, recordingSettings: { ...settings, autoLap: { trigger: "distance", meters: 1500 as 1000 } } } }])).toThrow(ZodError);
    expect(() => make.write([{ kind: "insert", table: "sport_preference", row: { sport: "trail", enabled: true, position: 0, recordingSettings: { ...settings, readout: { main: "distance", secondary: ["distance", "moving", "ascent"] } } } }])).toThrow(ZodError);
  });

  it("stores the settings on the sport's preference, adding a disabled one when it has none", () => {
    make.write([{ kind: "insert", table: "sport_preference", row: { sport: "run", enabled: true, position: 0 } }]);
    const trail = resolveProfile("trail", {});
    if (trail === null) throw new Error("trail records");
    make.write([recordingSettingsMutation(context.db, "trail", settings)]);
    make.write([recordingSettingsMutation(context.db, "trail", { ...settings, autoPause: true })]);
    expect(recordingSettingsOf(context.db, trail)).toEqual({ ...settings, autoPause: true });
    expect(context.db.select().from(sportPreference).all().map((row) => ({ sport: row.sport, enabled: row.enabled, position: row.position }))).toEqual([
      { sport: "run", enabled: true, position: 0 },
      { sport: "trail", enabled: false, position: 1 },
    ]);
  });
});
