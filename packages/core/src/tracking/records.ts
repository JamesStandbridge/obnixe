import { and, asc, eq, inArray, isNull, like } from "drizzle-orm";
import { bestEffort, recording, session } from "@obnixe/schema";
import type { BestEffort, BestEffortKey, EpochMs, FieldValues, Id, LocalDate, SportKey } from "@obnixe/schema";
import type { ObnixeDatabase } from "../database.ts";
import { sessionDurationSeconds } from "../stats/sessions.ts";
import { countsInRecords } from "./derived.ts";

/** Whether a best effort was a personal record when it was set, and whether it still is. */
export type RecordStanding = "current" | "former" | null;

export type Standings = ReadonlyMap<Id, ReadonlyMap<BestEffortKey, RecordStanding>>;

export const isAscentEffort = (effort: BestEffortKey): boolean => effort.endsWith(":ascent_1h");

/** The distance in meters of a distance effort, `null` for an ascent effort. */
export function effortMeters(effort: BestEffortKey): number | null {
  if (isAscentEffort(effort)) return null;
  return Number(effort.slice(effort.lastIndexOf(":") + 1));
}

/** Higher is better: the ascent of an `ascent_1h` effort, the opposite of the time of a distance effort. */
export function effortScore(row: Pick<BestEffort, "effort" | "elapsedMs" | "ascentMm">): number {
  return isAscentEffort(row.effort) ? (row.ascentMm ?? 0) : -row.elapsedMs;
}

/** One best effort of an activity in force, with what the records screen links to. */
export interface EffortEntry {
  readonly sessionId: Id;
  readonly effort: BestEffortKey;
  readonly startedAt: EpochMs;
  readonly localDate: LocalDate;
  readonly title: string | null;
  readonly elapsedMs: number;
  readonly movingMs: number;
  readonly startOffsetMs: number;
  readonly ascentMm: number | null;
}

/** Efforts of the completed sessions outside the trash, in start order (`PR-003`): records are never stored. */
function effortEntries(db: ObnixeDatabase, filter: { readonly efforts: readonly BestEffortKey[] } | { readonly sport: SportKey }): readonly EffortEntry[] {
  const kind = "efforts" in filter ? inArray(bestEffort.effort, [...new Set(filter.efforts)]) : like(bestEffort.effort, `${filter.sport}:%`);
  return db
    .select({
      sessionId: bestEffort.sessionId,
      effort: bestEffort.effort,
      startedAt: session.startedAt,
      localDate: session.localDate,
      title: session.title,
      elapsedMs: bestEffort.elapsedMs,
      movingMs: bestEffort.movingMs,
      startOffsetMs: bestEffort.startOffsetMs,
      ascentMm: bestEffort.ascentMm,
    })
    .from(bestEffort)
    .innerJoin(session, eq(bestEffort.sessionId, session.id))
    .where(and(kind, isNull(session.deletedAt), eq(session.status, "completed")))
    .orderBy(asc(bestEffort.effort), asc(session.startedAt), asc(session.id))
    .all();
}

/** Replays every effort of these kinds in start order over the kept sessions: a record beats every effort set before it. */
export function recordStandings(db: ObnixeDatabase, efforts: readonly BestEffortKey[]): Standings {
  const standings = new Map<Id, Map<BestEffortKey, RecordStanding>>();
  if (efforts.length === 0) return standings;
  const best = new Map<BestEffortKey, { readonly sessionId: Id; readonly score: number }>();
  for (const row of effortEntries(db, { efforts })) {
    const score = effortScore(row);
    const previous = best.get(row.effort);
    const record = previous === undefined || score > previous.score;
    if (record && previous !== undefined) standings.get(previous.sessionId)?.set(row.effort, "former");
    if (record) best.set(row.effort, { sessionId: row.sessionId, score });
    const own = standings.get(row.sessionId) ?? new Map<BestEffortKey, RecordStanding>();
    own.set(row.effort, record ? "current" : null);
    standings.set(row.sessionId, own);
  }
  return standings;
}

/** Better first; the earlier effort wins a tie, as it set the record first. */
function byScore(left: EffortEntry, right: EffortEntry): number {
  return effortScore(right) - effortScore(left) || left.startedAt - right.startedAt;
}

export const podiumSize = 3;

/** `PR-005` for one effort: the three best all time, the best of the year, and each record in the order it was set. */
export interface EffortBoard {
  readonly effort: BestEffortKey;
  readonly podium: readonly EffortEntry[];
  readonly yearBest: EffortEntry | null;
  readonly progression: readonly EffortEntry[];
  readonly count: number;
}

/** Distance efforts by distance, then the ascent ones. */
function effortOrder(left: BestEffortKey, right: BestEffortKey): number {
  return (effortMeters(left) ?? Number.POSITIVE_INFINITY) - (effortMeters(right) ?? Number.POSITIVE_INFINITY);
}

/** The records of `sport` (`PR-003`, `PR-005`), `year` being the calendar year of « meilleur de l'année ». */
export function effortBoards(db: ObnixeDatabase, sport: SportKey, year: number): readonly EffortBoard[] {
  const byEffort = new Map<BestEffortKey, EffortEntry[]>();
  for (const entry of effortEntries(db, { sport })) {
    const list = byEffort.get(entry.effort);
    if (list === undefined) byEffort.set(entry.effort, [entry]);
    else list.push(entry);
  }
  const yearPrefix = `${String(year).padStart(4, "0")}-`;
  return [...byEffort.entries()]
    .sort(([left], [right]) => effortOrder(left, right))
    .map(([effort, entries]): EffortBoard => {
      const progression: EffortEntry[] = [];
      for (const entry of entries) {
        const previous = progression.at(-1);
        if (previous === undefined || effortScore(entry) > effortScore(previous)) progression.push(entry);
      }
      const ranked = [...entries].sort(byScore);
      return { effort, podium: ranked.slice(0, podiumSize), yearBest: ranked.find((entry) => entry.localDate.startsWith(yearPrefix)) ?? null, progression, count: entries.length };
    });
}

/** Where an effort of one activity stands among every activity in force: its rank and whether it was a record when set. */
export interface EffortRank {
  readonly rank: number;
  readonly standing: RecordStanding;
}

/** The badges of an activity's best efforts (`SUM-001`): empty when it counts in no record. */
export function sessionEffortRanks(db: ObnixeDatabase, sessionId: Id): ReadonlyMap<BestEffortKey, EffortRank> {
  const own = db.select({ effort: bestEffort.effort }).from(bestEffort).where(eq(bestEffort.sessionId, sessionId)).all();
  const ranks = new Map<BestEffortKey, EffortRank>();
  if (own.length === 0) return ranks;
  const efforts = own.map((row) => row.effort);
  const standings = recordStandings(db, efforts).get(sessionId);
  const entries = effortEntries(db, { efforts });
  for (const effort of efforts) {
    const ranked = entries.filter((entry) => entry.effort === effort).sort(byScore);
    const position = ranked.findIndex((entry) => entry.sessionId === sessionId);
    if (position >= 0) ranks.set(effort, { rank: position + 1, standing: standings?.get(effort) ?? null });
  }
  return ranks;
}

export const activityRecordKinds = ["distance", "moving", "ascent", "altitude", "speed"] as const;
export type ActivityRecordKind = (typeof activityRecordKinds)[number];

/** `speed`: the fastest average of a bike activity of at least this distance. */
export const speedRecordMinMeters = 20_000;

/**
 * A maximum over whole activities: `value` in millimeters for `distance`, `ascent` and `altitude`, milliseconds for `moving`,
 * mm/s for `speed`.
 */
export interface ActivityRecord {
  readonly kind: ActivityRecordKind;
  readonly sessionId: Id;
  readonly localDate: LocalDate;
  readonly title: string | null;
  readonly value: number;
}

type ActivityValues = Readonly<Record<ActivityRecordKind, number | null>>;

function manualValues(values: FieldValues, durationSeconds: number | null): ActivityValues {
  const distance = typeof values.distance === "number" && values.distance > 0 ? values.distance * 1000 : null;
  const moving = durationSeconds === null || durationSeconds <= 0 ? null : durationSeconds * 1000;
  const ascent = typeof values.elevation_gain === "number" && values.elevation_gain > 0 ? values.elevation_gain * 1000 : null;
  return { distance, moving, ascent, altitude: null, speed: distance !== null && moving !== null ? (distance * 1000) / moving : null };
}

/**
 * The activity records of `sport` (`PR-005`): recorded activities that count in records (`PR-002`) and the sessions logged by
 * hand with the value; the altitude needs a track, and an electric bike counts in no bike record.
 */
export function activityRecords(db: ObnixeDatabase, sport: SportKey): readonly ActivityRecord[] {
  const rows = db
    .select({ session, recording })
    .from(session)
    .leftJoin(recording, eq(recording.sessionId, session.id))
    .where(and(eq(session.sport, sport), isNull(session.deletedAt), eq(session.status, "completed")))
    .orderBy(asc(session.startedAt), asc(session.id))
    .all();
  const best = new Map<ActivityRecordKind, ActivityRecord>();
  for (const { session: row, recording: measured } of rows) {
    let values: ActivityValues;
    if (measured === null) {
      if (sport === "bike" && row.values.e_bike === true) continue;
      values = manualValues(row.values, sessionDurationSeconds(row));
    } else {
      if (!countsInRecords(measured, row.sport, row.values)) continue;
      values = {
        distance: measured.distanceMm > 0 ? measured.distanceMm : null,
        moving: measured.movingMs > 0 ? measured.movingMs : null,
        ascent: measured.ascentMm,
        altitude: measured.altitudeMaxMm,
        speed: measured.movingMs > 0 ? (measured.distanceMm * 1000) / measured.movingMs : null,
      };
    }
    for (const kind of activityRecordKinds) {
      const value = values[kind];
      if (value === null || value <= 0) continue;
      if (kind === "speed" && (sport !== "bike" || (values.distance ?? 0) < speedRecordMinMeters * 1000)) continue;
      const previous = best.get(kind);
      if (previous === undefined || value > previous.value) best.set(kind, { kind, sessionId: row.id, localDate: row.localDate, title: row.title, value });
    }
  }
  return activityRecordKinds.flatMap((kind) => best.get(kind) ?? []);
}
