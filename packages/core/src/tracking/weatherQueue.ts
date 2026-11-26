import { and, desc, eq, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import { recording, recordingDerivation, session, weatherFetch } from "@obnixe/schema";
import type { EpochMs, Id, RecordingWeather } from "@obnixe/schema";
import type { ObnixeDatabase } from "../database.ts";
import { readSettings } from "../settings.ts";
import type { Mutation } from "../writer.ts";
import type { WeatherActivity } from "./weather.ts";

/** Requests sent per pass of the deferred queue before it looks for due recordings again. */
export const weatherBatchSize = 10;

const firstRetryDelayMs = 15 * 60_000;
const retryBackoffFactor = 4;

/** The earliest next attempt after `failedAttempts` failures: 15 min, then 1 h, then 4 h, so foregrounds do not hammer the provider. */
export function weatherRetryAt(failedAttempts: number, now: EpochMs): EpochMs {
  return (now + firstRetryDelayMs * retryBackoffFactor ** (failedAttempts - 1)) as EpochMs;
}

/** A saved recording whose weather may be requested now. */
export interface DueWeather {
  readonly sessionId: Id;
  readonly failedAttempts: number;
  readonly activity: WeatherActivity;
}

/**
 * Completed recordings in force, live or imported (`WTH-001`, `WTH-003`), still without weather and due for an attempt: never
 * tried, or past the backoff of their last failure; newest first. The start comes from the derivation, so a recording waits for
 * its first derivation, and one without a position or with simulated fixes is never requested.
 */
export function dueWeather(db: ObnixeDatabase, now: EpochMs, limit: number): readonly DueWeather[] {
  return db
    .select({
      sessionId: session.id,
      startedAt: session.startedAt,
      endedAt: session.endedAt,
      startLatitudeE7: sql<number>`${recordingDerivation.startLatitudeE7}`,
      startLongitudeE7: sql<number>`${recordingDerivation.startLongitudeE7}`,
      failedAttempts: weatherFetch.failedAttempts,
    })
    .from(recording)
    .innerJoin(session, eq(session.id, recording.sessionId))
    .innerJoin(recordingDerivation, eq(recordingDerivation.sessionId, recording.sessionId))
    .leftJoin(weatherFetch, eq(weatherFetch.sessionId, recording.sessionId))
    .where(
      and(
        isNull(recording.weather),
        eq(recording.simulated, false),
        eq(session.status, "completed"),
        isNull(session.deletedAt),
        isNotNull(recordingDerivation.startLatitudeE7),
        or(isNull(weatherFetch.sessionId), lte(weatherFetch.retryAt, now)),
      ),
    )
    .orderBy(desc(session.startedAt))
    .limit(limit)
    .all()
    .map((row) => ({
      sessionId: row.sessionId,
      failedAttempts: row.failedAttempts ?? 0,
      activity: { startLatitudeE7: row.startLatitudeE7, startLongitudeE7: row.startLongitudeE7, startedAt: row.startedAt, endedAt: row.endedAt ?? row.startedAt },
    }));
}

export interface WeatherPlan {
  readonly sessionId: Id;
  /** The recording's `updatedAt` the plan was made on, right before its commit. */
  readonly recordingUpdatedAt: EpochMs;
  readonly mutations: readonly Mutation[];
}

/** The journaled write of fetched weather into `recording.weather` (`WTH-002`); `null` when the recording is gone or already has weather. */
export function planWeather(db: ObnixeDatabase, sessionId: Id, weather: RecordingWeather): WeatherPlan | null {
  const current = db.select({ id: recording.id, updatedAt: recording.updatedAt, weather: recording.weather }).from(recording).where(eq(recording.sessionId, sessionId)).get();
  if (current === undefined || current.weather !== null) return null;
  return { sessionId, recordingUpdatedAt: current.updatedAt, mutations: [{ kind: "update", table: "recording", key: current.id, patch: { weather } }] };
}

/**
 * Call right after committing `plan.mutations`: drops the request's failure state and keeps a derivation that was current
 * before the commit current, since weather changes no derived row.
 */
export function weatherStored(db: ObnixeDatabase, plan: WeatherPlan): void {
  db.transaction((tx) => {
    tx.delete(weatherFetch).where(eq(weatherFetch.sessionId, plan.sessionId)).run();
    const current = tx.select({ updatedAt: recording.updatedAt }).from(recording).where(eq(recording.sessionId, plan.sessionId)).get();
    if (current === undefined) return;
    tx.update(recordingDerivation)
      .set({ recordingUpdatedAt: current.updatedAt })
      .where(and(eq(recordingDerivation.sessionId, plan.sessionId), eq(recordingDerivation.recordingUpdatedAt, plan.recordingUpdatedAt)))
      .run();
  });
}

/** Keeps a failed request for a later attempt at `retryAt`, or gives it up with `null` (`WTH-003`). */
export function recordWeatherFailure(db: ObnixeDatabase, sessionId: Id, failedAttempts: number, retryAt: EpochMs | null): void {
  db.insert(weatherFetch)
    .values({ sessionId, failedAttempts, retryAt })
    .onConflictDoUpdate({ target: weatherFetch.sessionId, set: { failedAttempts, retryAt } })
    .run();
}

/** What the detail shows of an activity's weather: nothing when it has no position, is simulated, or weather requests are off. */
export type ActivityWeather =
  | { readonly status: "stored"; readonly weather: RecordingWeather }
  | { readonly status: "pending" }
  | { readonly status: "unavailable" }
  | { readonly status: "none" };

export function activityWeather(db: ObnixeDatabase, sessionId: Id): ActivityWeather {
  const row = db
    .select({
      weather: recording.weather,
      simulated: recording.simulated,
      derived: recordingDerivation.sessionId,
      startLatitudeE7: recordingDerivation.startLatitudeE7,
      fetched: weatherFetch.sessionId,
      retryAt: weatherFetch.retryAt,
    })
    .from(recording)
    .leftJoin(recordingDerivation, eq(recordingDerivation.sessionId, recording.sessionId))
    .leftJoin(weatherFetch, eq(weatherFetch.sessionId, recording.sessionId))
    .where(eq(recording.sessionId, sessionId))
    .get();
  if (row === undefined) return { status: "none" };
  if (row.weather !== null) return { status: "stored", weather: row.weather };
  if (row.simulated || (row.derived !== null && row.startLatitudeE7 === null) || !readSettings(db).weatherEnabled) return { status: "none" };
  return row.fetched !== null && row.retryAt === null ? { status: "unavailable" } : { status: "pending" };
}
