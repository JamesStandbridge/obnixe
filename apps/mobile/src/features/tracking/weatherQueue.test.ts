import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { commit, computeImport, planImport, readActivityFile, updateSettings } from "@obnixe/core";
import type { Mutation, WeatherTransport } from "@obnixe/core";
import { changeset, recording, settings, weatherFetch } from "@obnixe/schema";
import type { EpochMs, Id } from "@obnixe/schema";
import { DerivedRebuild } from "@/features/tracking/derivedRebuild";
import { writeTrack } from "@/features/tracking/trackStore";
import { WeatherQueue } from "@/features/tracking/weatherQueue";
import type { WeatherQueueOptions } from "@/features/tracking/weatherQueue";
import { db, environment } from "../../../test/mocks/database.ts";

const minuteMs = 60_000;
const hourMs = 60 * minuteMs;
const metersPerE7 = 111_195 / 1e7;
const home = { latitudeE7: 451_885_000, longitudeE7: 57_245_000 };
const firstStart = Date.UTC(2026, 10, 25, 7, 40) as EpochMs;

const write = (summary: string, mutations: readonly Mutation[]): Id => commit(db(), environment, { actor: { author: "user", connectionId: null }, summary, revertsId: null, mutations });
const fail = (error: unknown): void => {
  throw error;
};

let clock: EpochMs;
let urls: string[];

beforeEach(() => {
  db()
    .insert(settings)
    .values({ singleton: 1, theme: "dark", massUnit: "kg", agentCanReadBody: false, agentCanWrite: false, agentCanReadPhotos: false, reminderWeekdays: 0, reminderMinutes: 1110, remindersExportedAt: null, agentChangesSeenAt: null, bridgeHost: null, updatedAt: environment.now() })
    .run();
  clock = (firstStart + 3 * hourMs) as EpochMs;
  urls = [];
});

/** A 4 minute GPX run north from home, imported and derived like the app does after an import. */
async function imported(startedAt: EpochMs): Promise<Id> {
  const points = Array.from({ length: 240 }, (_, index) => {
    const latitude = (home.latitudeE7 + Math.round((index * 3) / metersPerE7)) / 1e7;
    return `<trkpt lat="${latitude.toFixed(7)}" lon="${(home.longitudeE7 / 1e7).toFixed(7)}"><ele>250</ele><time>${new Date(startedAt + index * 1000).toISOString()}</time></trkpt>`;
  });
  const gpx = `<?xml version="1.0"?><gpx version="1.1" creator="test" xmlns="http://www.topografix.com/GPX/1/1"><trk><type>running</type><trkseg>${points.join("")}</trkseg></trk></gpx>`;
  const plan = planImport(db(), environment, { computation: computeImport(readActivityFile(new TextEncoder().encode(gpx)), { sport: "run", values: {} }), timeZone: "Europe/Paris", replaceSessionId: null });
  if (plan.track === null) throw new Error("No track");
  await writeTrack(plan.recordingId, plan.track.bytes);
  commit(db(), environment, plan.request);
  await new DerivedRebuild({ write }, fail).request();
  return plan.sessionId;
}

/** An Open-Meteo body for the hours around `startedAt`, as the forecast API answers in unixtime and SI units. */
function forecastBody(startedAt: EpochMs): unknown {
  const first = Math.floor(startedAt / hourMs) * hourMs - hourMs;
  const time = [0, 1, 2, 3].map((index) => (first + index * hourMs) / 1000);
  const series = (value: number): readonly number[] => time.map(() => value);
  return {
    hourly_units: { time: "unixtime", temperature_2m: "°C", apparent_temperature: "°C", relative_humidity_2m: "%", precipitation: "mm", wind_speed_10m: "m/s", wind_direction_10m: "°", wind_gusts_10m: "m/s" },
    hourly: {
      time,
      temperature_2m: series(14.2),
      apparent_temperature: series(12.4),
      relative_humidity_2m: series(81),
      precipitation: series(0.2),
      weather_code: series(61),
      wind_speed_10m: series(5),
      wind_direction_10m: series(315),
      wind_gusts_10m: series(9.4),
    },
  };
}

function answering(status: number, body: (url: string) => unknown = () => ({})): WeatherTransport {
  return async (url) => {
    urls.push(url);
    return { status, json: async () => body(url) };
  };
}

const forecast: WeatherTransport = answering(200, () => forecastBody(firstStart));

function queue(overrides: Partial<WeatherQueueOptions> = {}): WeatherQueue {
  return new WeatherQueue({ writer: { write }, transport: forecast, online: async () => true, recording: () => false, now: () => clock, report: fail, ...overrides });
}

const weatherOf = (sessionId: Id) => db().select({ weather: recording.weather }).from(recording).where(eq(recording.sessionId, sessionId)).get()?.weather ?? null;
const fetchOf = (sessionId: Id) => db().select().from(weatherFetch).where(eq(weatherFetch.sessionId, sessionId)).get() ?? null;

describe("weather queue", () => {
  it("WTH-001 stores the weather of an imported activity, asked at its start rounded to 0.1 degree (DEC-13)", async () => {
    const sessionId = await imported(firstStart);
    await queue().request();
    expect(urls).toHaveLength(1);
    const params = new URL(urls[0] ?? "").searchParams;
    expect([params.get("latitude"), params.get("longitude")]).toEqual(["45.2", "5.7"]);
    expect(weatherOf(sessionId)).toMatchObject({ source: "open_meteo_forecast", fetchedAt: clock, hours: [{ at: Date.UTC(2026, 10, 25, 7), temperatureDeciC: 142, windSpeedMmS: 5000, weatherCode: 61 }, { at: Date.UTC(2026, 10, 25, 8) }] });
    expect(db().select({ summary: changeset.summary }).from(changeset).all().at(-1)?.summary).toBe("Météo de l'activité");
    await queue().request();
    expect(urls).toHaveLength(1);
  });

  it("WTH-003 sends nothing when the setting is off, offline, or while recording (PRV-020)", async () => {
    const sessionId = await imported(firstStart);
    updateSettings(db(), { weatherEnabled: false }, clock);
    await queue().request();
    updateSettings(db(), { weatherEnabled: true }, clock);
    await queue({ online: async () => false }).request();
    await queue({ recording: () => true }).request();
    expect(urls).toEqual([]);
    expect(fetchOf(sessionId)).toBeNull();
    await queue().request();
    expect(weatherOf(sessionId)).not.toBeNull();
  });

  it("WTH-003 retries a failed request after its backoff, at most three times", async () => {
    const sessionId = await imported(firstStart);
    const failing = queue({ transport: answering(503) });
    await failing.request();
    expect(fetchOf(sessionId)).toEqual({ sessionId, failedAttempts: 1, retryAt: clock + 15 * minuteMs });
    await failing.request();
    expect(urls).toHaveLength(1);
    for (const wait of [15 * minuteMs, hourMs, 4 * hourMs]) {
      clock = (clock + wait) as EpochMs;
      await failing.request();
    }
    expect(urls).toHaveLength(4);
    expect(fetchOf(sessionId)).toEqual({ sessionId, failedAttempts: 4, retryAt: null });
    clock = (clock + 24 * hourMs) as EpochMs;
    await queue().request();
    expect(urls).toHaveLength(4);
    expect(weatherOf(sessionId)).toBeNull();
  });

  it("gives up at once when Open-Meteo rejects the request", async () => {
    const sessionId = await imported(firstStart);
    await queue({ transport: answering(400, () => ({ error: true, reason: "Parameter 'latitude' is out of range" })) }).request();
    expect(fetchOf(sessionId)).toEqual({ sessionId, failedAttempts: 1, retryAt: null });
  });

  it("stops the pass when the connection drops, leaving the other activities untried", async () => {
    const older = await imported(firstStart);
    const newer = await imported((firstStart + hourMs) as EpochMs);
    await queue({
      transport: async (url) => {
        urls.push(url);
        throw new TypeError("Network request failed");
      },
    }).request();
    expect(urls).toHaveLength(1);
    expect(fetchOf(newer)).toMatchObject({ failedAttempts: 1 });
    expect(fetchOf(older)).toBeNull();
  });
});
