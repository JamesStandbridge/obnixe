import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { change, recording, session, weatherFetch } from "@obnixe/schema";
import type { EpochMs, Id, RecordingWeather } from "@obnixe/schema";
import { fixtures } from "../data/testFixtures.ts";
import type { Fixtures } from "../data/testFixtures.ts";
import { trashMutation } from "../data/trash.ts";
import { updateSettings } from "../settings.ts";
import { createTestContext } from "../testing.ts";
import type { TestContext } from "../testing.ts";
import { processTrack } from "./batch.ts";
import type { ProcessedTrack } from "./batch.ts";
import { encodeTrack, trackDigest } from "./codec/track.ts";
import type { Track } from "./codec/track.ts";
import { staleDerivationCount, storeDerivation } from "./derived.ts";
import { computeImport, planImport } from "./io/import.ts";
import { readActivityFile } from "./io/zip.ts";
import { planRecordingSave, planRecordingStart, recordingStartMutations } from "./plans.ts";
import { activePrivacyMask } from "./privacyZones.ts";
import { coreScenarios } from "./testing/scenarios.ts";
import { profileOf, recordedLaps, untrimmed } from "./testing/run.ts";
import { toSampleColumns } from "./types.ts";
import { activityWeather, dueWeather, planWeather, recordWeatherFailure, weatherRetryAt, weatherStored } from "./weatherQueue.ts";

const minuteMs = 60_000;
const hourMs = 60 * minuteMs;

let context: TestContext;
let make: Fixtures;
let samples: Track["samples"];
let processed: ProcessedTrack;

const weather: RecordingWeather = {
  source: "open_meteo_forecast",
  fetchedAt: Date.UTC(2026, 9, 24, 14),
  hours: [{ at: Date.UTC(2026, 9, 24, 7), temperatureDeciC: 46, apparentTemperatureDeciC: 30, humidityPercent: 97, precipitationDeciMm: 2, weatherCode: 61, windSpeedMmS: 500, windDirectionDeg: 323, windGustMmS: 2300 }],
};

beforeAll(() => {
  const scenario = coreScenarios.steadyRun(2);
  samples = toSampleColumns(scenario.samples);
  const endT = scenario.samples.at(-1)?.t ?? 0;
  processed = processTrack({ startedAt: 0 as EpochMs, samples, marks: [{ kind: "start", t: 0 }, { kind: "stop", t: endT }] }, profileOf(scenario), { laps: recordedLaps, trim: untrimmed });
});

beforeEach(() => {
  context = createTestContext();
  make = fixtures(context);
});

const now = (): EpochMs => context.env.now();

/** A saved live run started at `startedAt`, derived like the rebuild does unless `derived` is false. */
function recorded(startedAt: EpochMs, derived = true): Id {
  const plan = planRecordingStart(context.db, context.env, { sport: "run", values: {}, gearId: null, slot: null, timeZone: "Europe/Paris" });
  make.write(recordingStartMutations(plan, { startedAt, device: "Pixel 9 Pro" }));
  const track: Track = { startedAt, samples, marks: [{ kind: "start", t: 0 }, { kind: "stop", t: processed.elapsed.endMs }] };
  const bytes = encodeTrack(track);
  make.write(planRecordingSave(context.db, context.env, { sessionId: plan.sessionId, track, processed, stored: { file: `tracks/${plan.recordingId}.otrk`, sha256: trackDigest(bytes), bytes: bytes.length }, pains: [] }));
  if (derived) storeDerivation(context.db, plan.sessionId, track, processed, activePrivacyMask(context.db));
  return plan.sessionId;
}

function imported(name: string): Id {
  const activity = readActivityFile(new Uint8Array(readFileSync(new URL(`../../test/fixtures/import/${name}`, import.meta.url))));
  if (activity.sport === null) throw new Error(`${name} has no sport`);
  const computation = computeImport(activity, activity.sport);
  const plan = planImport(context.db, context.env, { computation, timeZone: "Europe/Paris", replaceSessionId: null });
  make.write(plan.request.mutations);
  if (computation.processed === null) throw new Error(`${name} has no track`);
  storeDerivation(context.db, plan.sessionId, computation.track, computation.processed, activePrivacyMask(context.db));
  return plan.sessionId;
}

function store(sessionId: Id): void {
  const plan = planWeather(context.db, sessionId, weather);
  if (plan === null) throw new Error("nothing to store");
  make.write(plan.mutations);
  weatherStored(context.db, plan);
}

const due = (): readonly Id[] => dueWeather(context.db, now(), 10).map((item) => item.sessionId);
const morning = (hour: number): EpochMs => Date.UTC(2026, 9, 24, hour) as EpochMs;

describe("dueWeather (WTH-001, WTH-003)", () => {
  it("lists derived recordings without weather, newest first, with the raw start and the activity window", () => {
    const early = recorded(morning(6));
    const late = recorded(morning(9));
    expect(due()).toEqual([late, early]);
    const [item] = dueWeather(context.db, now(), 1);
    const row = context.db.select().from(session).where(eq(session.id, late)).get();
    expect(item).toEqual({ sessionId: late, failedAttempts: 0, activity: { startLatitudeE7: samples.fixes.latitudeE7[0], startLongitudeE7: samples.fixes.longitudeE7[0], startedAt: morning(9), endedAt: row?.endedAt } });
  });

  it("includes imported activities", () => {
    const run = imported("venu3s-run.fit");
    expect(due()).toEqual([run]);
  });

  it("waits for the derivation and skips simulated, trashed and stored recordings", () => {
    recorded(morning(5), false);
    const simulated = recorded(morning(6));
    context.db.update(recording).set({ simulated: true }).where(eq(recording.sessionId, simulated)).run();
    const trashed = recorded(morning(7));
    make.write([trashMutation("session", trashed, now())]);
    const stored = recorded(morning(8));
    store(stored);
    expect(due()).toEqual([]);
  });

  it("holds a failed request until its retry time and drops a given up one", () => {
    const retried = recorded(morning(6));
    const abandoned = recorded(morning(7));
    recordWeatherFailure(context.db, retried, 1, weatherRetryAt(1, now()));
    recordWeatherFailure(context.db, abandoned, 4, null);
    expect(due()).toEqual([]);
    context.advance(15 * minuteMs);
    expect(dueWeather(context.db, now(), 10)).toMatchObject([{ sessionId: retried, failedAttempts: 1 }]);
  });
});

describe("weatherRetryAt", () => {
  it("backs off 15 min, 1 h then 4 h", () => {
    const at = morning(12);
    expect([1, 2, 3].map((failed) => weatherRetryAt(failed, at) - at)).toEqual([15 * minuteMs, hourMs, 4 * hourMs]);
  });
});

describe("weather write (WTH-002)", () => {
  it("writes recording.weather through the journal and forgets the failures", () => {
    const sessionId = recorded(morning(9));
    recordWeatherFailure(context.db, sessionId, 2, now());
    store(sessionId);
    const row = context.db.select().from(recording).where(eq(recording.sessionId, sessionId)).get();
    expect(row?.weather).toEqual(weather);
    expect(context.db.select().from(change).where(eq(change.rowId, row?.id ?? "")).all().at(-1)?.operation).toBe("update");
    expect(context.db.select().from(weatherFetch).all()).toEqual([]);
    expect(planWeather(context.db, sessionId, weather)).toBeNull();
  });

  it("keeps a current derivation current and a stale one stale", () => {
    const current = recorded(morning(8));
    const stale = recorded(morning(9));
    context.advance(1000);
    make.write([{ kind: "update", table: "recording", key: context.db.select().from(recording).where(eq(recording.sessionId, stale)).get()?.id ?? "", patch: { trimStartMs: 1000 } }]);
    expect(staleDerivationCount(context.db, activePrivacyMask(context.db))).toBe(1);
    context.advance(1000);
    store(current);
    store(stale);
    expect(staleDerivationCount(context.db, activePrivacyMask(context.db))).toBe(1);
  });
});

describe("activityWeather", () => {
  it("tells stored, pending, given up and hidden weather apart", () => {
    const sessionId = recorded(morning(9));
    expect(activityWeather(context.db, sessionId)).toEqual({ status: "pending" });
    recordWeatherFailure(context.db, sessionId, 1, weatherRetryAt(1, now()));
    expect(activityWeather(context.db, sessionId)).toEqual({ status: "pending" });
    recordWeatherFailure(context.db, sessionId, 4, null);
    expect(activityWeather(context.db, sessionId)).toEqual({ status: "unavailable" });
    updateSettings(context.db, { weatherEnabled: false }, now());
    expect(activityWeather(context.db, sessionId)).toEqual({ status: "none" });
    store(sessionId);
    expect(activityWeather(context.db, sessionId)).toEqual({ status: "stored", weather });
  });

  it("shows nothing for a simulated activity", () => {
    const sessionId = recorded(morning(9));
    context.db.update(recording).set({ simulated: true }).where(eq(recording.sessionId, sessionId)).run();
    expect(activityWeather(context.db, sessionId)).toEqual({ status: "none" });
  });
});
