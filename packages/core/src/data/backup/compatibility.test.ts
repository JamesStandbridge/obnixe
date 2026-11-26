import { readFileSync } from "node:fs";
import Database from "better-sqlite3";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { gear, programSlot, session, settings, sportPreference } from "@obnixe/schema";
import type { EpochMs, Id } from "@obnixe/schema";
import { readSettings } from "../../settings.ts";
import type { SettingsValues } from "../../settings.ts";
import { createTestContext, testUpgrader } from "../../testing.ts";
import type { TestContext } from "../../testing.ts";
import { parsePackedSnapshot } from "./container.ts";
import { openSnapshot } from "./envelope.ts";
import { mergeSnapshot } from "./merge.ts";
import { replaceWithSnapshot } from "./replace.ts";
import { backupSchemaVersion, buildSnapshot, parseSnapshotTables } from "./snapshot.ts";
import type { Snapshot } from "./snapshot.ts";

const fixtures = new URL("../../../test/fixtures/", import.meta.url);
const databaseV1 = readFileSync(new URL("database-v1.sql", fixtures), "utf8");
const backupV1 = new Uint8Array(readFileSync(new URL("backup-v1.obnixe", fixtures)));
const passphrase = "fixture v1 corde rouge";

const trailGearId = (runGearId: string): Id => `${runGearId.slice(0, 19)}c${runGearId.slice(20)}` as Id;

function tableCounts(sqlite: Database.Database): Record<string, number> {
  const tables = sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> '__drizzle_migrations'").pluck().all() as string[];
  return Object.fromEntries(tables.map((table) => [table, sqlite.prepare(`SELECT count(*) FROM "${table}"`).pluck().get() as number]));
}

function expectConverted(context: TestContext): void {
  const { db } = context;
  const speedgoat = db.select().from(gear).where(and(eq(gear.name, "Speedgoat 6"), eq(gear.sport, "run"))).get();
  expect(speedgoat).toBeDefined();
  const trailGear = db.select().from(gear).where(eq(gear.id, trailGearId(speedgoat?.id ?? ""))).get();
  expect(trailGear).toMatchObject({ sport: "trail", name: "Speedgoat 6", initialMeters: 0, createdAt: speedgoat?.createdAt });

  const trails = db.select().from(session).where(eq(session.sport, "trail")).all();
  expect(trails.filter((row) => row.deletedAt === null)).toHaveLength(2);
  for (const row of trails) {
    expect(row.values.kind).toBe("training");
    expect(row.gearId === null || row.gearId === trailGear?.id).toBe(true);
  }
  expect(trails.find((row) => row.values.distance === 18400)).toMatchObject({ gearId: trailGear?.id, values: { kind: "training", distance: 18400, elevation_gain: 1150, heart_rate_avg: 148 } });
  expect(db.select().from(session).where(eq(session.sport, "run")).all().map((row) => row.values)).toEqual([{ kind: "easy", distance: 8200, heart_rate_avg: 136 }]);
  expect(db.select({ values: session.values }).from(session).where(eq(session.sport, "swim")).get()?.values).toMatchObject({ kind: "crawl", water: "pool" });

  expect(db.select({ sport: programSlot.sport, targetValues: programSlot.targetValues }).from(programSlot).where(eq(programSlot.name, "Trail long")).get()).toEqual({
    sport: "trail",
    targetValues: { kind: "training", distance: 18000 },
  });
  const run = db.select().from(sportPreference).where(eq(sportPreference.sport, "run")).get();
  expect(db.select().from(sportPreference).where(eq(sportPreference.sport, "trail")).get()).toMatchObject({ enabled: true, position: run?.position, recordingSettings: null });

  const snapshot = buildSnapshot(db, context.env.now());
  expect(() => parseSnapshotTables(snapshot.tables)).not.toThrow();
}

describe("v1 database migrated in place", () => {
  let context: TestContext;

  beforeAll(() => {
    context = createTestContext(databaseV1);
  });

  it("converts trail runs, their gear and program slots, and pool swims (DAT-010, DAT-011)", () => {
    expectConverted(context);
  });

  it("converts trail runs in the trash too", () => {
    expect(context.db.select({ sport: session.sport }).from(session).where(isNotNull(session.deletedAt)).all()).toEqual([{ sport: "trail" }]);
  });

  it("loses no row and adds only the trail gear and preference", () => {
    const before = new Database(":memory:");
    before.exec(databaseV1);
    const after = tableCounts((context.db as unknown as { $client: Database.Database }).$client);
    const expected = { ...tableCounts(before), gear: (tableCounts(before).gear ?? 0) + 1, sport_preference: (tableCounts(before).sport_preference ?? 0) + 1 };
    expect(Object.fromEntries(Object.entries(after).filter(([table]) => table in expected))).toEqual(expected);
    expect(after.recording).toBe(0);
  });

  it("gives the new settings their defaults (DAT-004)", () => {
    expect(readSettings(context.db)).toMatchObject({
      agentCanReadLocation: true,
      keepScreenOn: false,
      countdown: false,
      mapStyle: "obnixe_outdoor",
      mapCacheMegabytes: 200,
      exportPrivacy: true,
      hideTrackEndsMeters: 0,
      maskInApp: false,
      birthYear: null,
      sex: null,
      maxHeartRate: null,
      weatherEnabled: true,
    });
  });

  it("keeps the foreign keys consistent", () => {
    expect(context.db.all(sql`PRAGMA foreign_key_check`)).toEqual([]);
  });
});

describe("v1 backup (DAT-032, TST-032)", () => {
  let opened: Snapshot;

  beforeAll(async () => {
    opened = await openSnapshot(backupV1, { passphrase, upgrader: testUpgrader });
  });

  it("opens as a current snapshot with its photo bytes", () => {
    expect(opened.schemaVersion).toBe(backupSchemaVersion);
    expect(opened.photos).toHaveLength(1);
    expect(Array.from(opened.photos[0]?.bytes ?? [])).toEqual([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]);
    expect(opened.tables.photo.map((row) => row.id)).toEqual(opened.photos.map((file) => file.photoId));
    expect(opened.settings.agentCanReadLocation).toBe(true);
  });

  function device(overrides: Partial<SettingsValues> = {}): TestContext {
    const context = createTestContext();
    context.db
      .insert(settings)
      .values({ ...opened.settings, updatedAt: 0 as EpochMs, ...overrides, singleton: 1 })
      .run();
    return context;
  }

  it("restores with the same conversions as the database migration", () => {
    const restored = device();
    replaceWithSnapshot(restored.db, restored.env, opened);
    expectConverted(restored);
  });

  it("merges into a fresh database", () => {
    const fresh = device();
    mergeSnapshot(fresh.db, fresh.env, opened);
    expectConverted(fresh);
  });

  it("merges into the same data migrated in place without duplicating the trail gear", () => {
    const migrated = createTestContext(databaseV1);
    const before = buildSnapshot(migrated.db, migrated.env.now()).tables;
    const result = mergeSnapshot(migrated.db, migrated.env, opened);
    expect(result.counts).toEqual({ inserted: 0, updated: 0, deleted: 0 });
    expect(buildSnapshot(migrated.db, migrated.env.now()).tables).toEqual(before);
  });

  it("never grants location access to the agent", () => {
    const local = device({ agentCanReadLocation: false, theme: "sunlight" });
    replaceWithSnapshot(local.db, local.env, opened);
    expect(readSettings(local.db)).toMatchObject({ agentCanReadLocation: false, theme: opened.settings.theme });
  });
});

describe("v2 backup", () => {
  it("gives the in-app mask its default", () => {
    const source = createTestContext();
    source.db
      .insert(settings)
      .values({
        singleton: 1,
        theme: "dark",
        massUnit: "kg",
        agentCanReadBody: false,
        agentCanWrite: false,
        agentCanReadPhotos: false,
        reminderWeekdays: 0,
        reminderMinutes: 1110,
        hideTrackEndsMeters: 300,
        maskInApp: true,
        updatedAt: source.env.now(),
      })
      .run();
    const current = buildSnapshot(source.db, source.env.now());
    const { maskInApp: _maskInApp, ...settingsV2 } = current.settings;
    const opened = parsePackedSnapshot({ ...current, schemaVersion: 2, settings: settingsV2 }, testUpgrader);
    expect(opened.schemaVersion).toBe(backupSchemaVersion);
    expect(opened.settings).toMatchObject({ hideTrackEndsMeters: 300, maskInApp: false });
  });
});

describe("v5 backup", () => {
  it("restores gear without a wear threshold", () => {
    const source = createTestContext();
    const gearId = source.env.newId();
    source.db
      .insert(settings)
      .values({ singleton: 1, theme: "dark", massUnit: "kg", agentCanReadBody: false, agentCanWrite: false, agentCanReadPhotos: false, reminderWeekdays: 0, reminderMinutes: 1110, updatedAt: source.env.now() })
      .run();
    source.db.insert(gear).values({ id: gearId, sport: "run", name: "Pegasus 40", initialMeters: 120_000, wearMeters: null, retiredAt: null, createdAt: source.env.now(), updatedAt: source.env.now() }).run();
    const current = buildSnapshot(source.db, source.env.now());
    const gearV5 = current.tables.gear.map(({ wearMeters: _wearMeters, ...row }) => row);
    const opened = parsePackedSnapshot({ ...current, schemaVersion: 5, tables: { ...current.tables, gear: gearV5 } }, testUpgrader);
    expect(opened.schemaVersion).toBe(backupSchemaVersion);
    expect(opened.tables.gear).toEqual([expect.objectContaining({ id: gearId, initialMeters: 120_000, wearMeters: null })]);
  });
});
