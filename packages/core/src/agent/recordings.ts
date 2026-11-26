import { asc, inArray } from "drizzle-orm";
import { bestEffort, lap, recording } from "@obnixe/schema";
import type { BestEffort, BestEffortKey, FieldValues, Id, Lap, Recording, RecordingWeather, SportKey } from "@obnixe/schema";
import type { ObnixeDatabase } from "../database.ts";
import { resolveProfile } from "../tracking/profile.ts";
import type { ResolvedProfile } from "../tracking/profile.ts";
import { recordStandings } from "../tracking/records.ts";
import type { RecordStanding } from "../tracking/records.ts";
import type { Json } from "./environment.ts";

export interface RecordedSession {
  readonly id: Id;
  readonly sport: SportKey;
  readonly values: FieldValues;
}

export const seconds = (ms: number): number => Math.round(ms / 1000);

export const meters = (mm: number): number => Math.round(mm / 1000);

const orNull = <T, R>(value: T | null, convert: (value: T) => R): R | null => (value === null ? null : convert(value));

const oneDecimal = (value: number): number => Math.round(value * 10) / 10;

export const kmh = (metersPerSecond: number): number => oneDecimal(metersPerSecond * 3.6);

/** Average pace over a stretch for the sports shown in pace, `null` for those shown in speed or without distance. */
export function paceSecondsPerKm(profile: ResolvedProfile | null, movingMs: number, distanceMm: number): number | null {
  if (profile?.primary !== "pace" || distanceMm <= 0) return null;
  return Math.round((movingMs * 1000) / distanceMm);
}

export function averageSpeedKmh(movingMs: number, distanceMm: number): number | null {
  return movingMs <= 0 ? null : kmh(distanceMm / movingMs);
}

function weatherJson(weather: RecordingWeather): Json {
  return {
    source: weather.source,
    hours: weather.hours.map((hour) => ({
      at: new Date(hour.at).toISOString(),
      temperatureC: hour.temperatureDeciC / 10,
      apparentTemperatureC: hour.apparentTemperatureDeciC / 10,
      humidityPercent: hour.humidityPercent,
      precipitationMm: hour.precipitationDeciMm / 10,
      weatherCode: hour.weatherCode,
      windSpeedKmh: kmh(hour.windSpeedMmS / 1000),
      windDirectionDeg: hour.windDirectionDeg,
      windGustKmh: kmh(hour.windGustMmS / 1000),
    })),
  };
}

function bestEffortJson(row: BestEffort, standing: RecordStanding): Json {
  return {
    effort: row.effort,
    elapsedSeconds: seconds(row.elapsedMs),
    movingSeconds: seconds(row.movingMs),
    startOffsetSeconds: seconds(row.startOffsetMs),
    ascentMeters: orNull(row.ascentMm, meters),
    record: standing,
  };
}

function lapJson(row: Lap): Json {
  return { trigger: row.trigger, workoutStep: row.workoutStep, startOffsetSeconds: seconds(row.startOffsetMs), endOffsetSeconds: seconds(row.endOffsetMs) };
}

interface RecordingParts {
  readonly row: Recording;
  readonly profile: ResolvedProfile | null;
  readonly laps: readonly Lap[];
  readonly efforts: readonly BestEffort[];
  readonly standings: ReadonlyMap<BestEffortKey, RecordStanding> | undefined;
}

function recordingJson({ row, profile, laps, efforts, standings }: RecordingParts): Json {
  return {
    source: row.source,
    importFormat: row.importFormat,
    device: row.device,
    simulated: row.simulated,
    elapsedSeconds: seconds(row.elapsedMs),
    movingSeconds: seconds(row.movingMs),
    distanceMeters: meters(row.distanceMm),
    ascentMeters: orNull(row.ascentMm, meters),
    descentMeters: orNull(row.descentMm, meters),
    altitudeMinMeters: orNull(row.altitudeMinMm, meters),
    altitudeMaxMeters: orNull(row.altitudeMaxMm, meters),
    elevationSource: row.elevationSource,
    paceSecondsPerKm: paceSecondsPerKm(profile, row.movingMs, row.distanceMm),
    averageSpeedKmh: averageSpeedKmh(row.movingMs, row.distanceMm),
    maxSpeedKmh: orNull(row.speedMaxMmS, (speed) => kmh(speed / 1000)),
    cadenceAvg: row.cadenceAvg,
    steps: row.steps,
    heartRateAvg: row.heartRateAvg,
    heartRateMax: row.heartRateMax,
    heartRateSource: row.heartRateSource,
    powerAvg: row.powerAvg,
    energyKcal: row.energyKcal,
    energyMethod: row.energyMethod,
    importedEnergyKcal: row.importedEnergyKcal,
    weather: orNull(row.weather, weatherJson),
    workout: row.workout,
    laps: laps.map(lapJson),
    bestEfforts: efforts.map((effort) => bestEffortJson(effort, standings?.get(effort.effort) ?? null)),
    hasTrack: row.trackFile !== null,
    goodFixPermille: row.goodFixPermille,
  };
}

/** The coordinate-free summary of each recorded session (`INT-040`), read from the stored rows only, keyed by session id. */
export function recordingSummaries(db: ObnixeDatabase, sessions: readonly RecordedSession[]): ReadonlyMap<Id, Json> {
  const summaries = new Map<Id, Json>();
  const ids = sessions.map((row) => row.id);
  if (ids.length === 0) return summaries;
  const rows = db.select().from(recording).where(inArray(recording.sessionId, ids)).all();
  if (rows.length === 0) return summaries;
  const recordedIds = rows.map((row) => row.sessionId);
  const laps = db.select().from(lap).where(inArray(lap.sessionId, recordedIds)).orderBy(asc(lap.position)).all();
  const efforts = db.select().from(bestEffort).where(inArray(bestEffort.sessionId, recordedIds)).orderBy(asc(bestEffort.effort)).all();
  const standings = recordStandings(db, efforts.map((effort) => effort.effort));
  const lapsBySession = bySession(laps);
  const effortsBySession = bySession(efforts);
  const owners = new Map(sessions.map((row) => [row.id, row]));
  for (const row of rows) {
    const owner = owners.get(row.sessionId);
    if (owner === undefined) continue;
    summaries.set(
      row.sessionId,
      recordingJson({
        row,
        profile: resolveProfile(owner.sport, owner.values),
        laps: lapsBySession.get(row.sessionId) ?? [],
        efforts: effortsBySession.get(row.sessionId) ?? [],
        standings: standings.get(row.sessionId),
      }),
    );
  }
  return summaries;
}

function bySession<T extends { readonly sessionId: Id }>(rows: readonly T[]): ReadonlyMap<Id, readonly T[]> {
  const grouped = new Map<Id, T[]>();
  for (const row of rows) {
    const group = grouped.get(row.sessionId);
    if (group === undefined) grouped.set(row.sessionId, [row]);
    else group.push(row);
  }
  return grouped;
}
