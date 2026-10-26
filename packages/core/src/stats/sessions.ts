import { and, asc, eq, gte, inArray, isNotNull, isNull, lte, ne, sql } from "drizzle-orm";
import { agentConnection, change, changeset, painReport, programSlot, programVariant, session, sessionItem, strengthEntry, strengthSet } from "@obnixe/schema";
import type { Effort, EpochMs, FieldValues, Id, LocalDate, PainLevel, ReviewStatus, Session, SportKey, ZoneKey } from "@obnixe/schema";
import type { ObnixeDatabase } from "../database.ts";

export type ReportedPainLevel = Exclude<PainLevel, "none">;

export interface ReportedZonePain {
  readonly zone: ZoneKey;
  readonly level: ReportedPainLevel;
}

export interface SessionSummary {
  readonly id: Id;
  readonly sport: SportKey;
  readonly title: string | null;
  readonly slotName: string | null;
  readonly variantName: string | null;
  readonly localDate: LocalDate;
  readonly startedAt: EpochMs;
  readonly durationSeconds: number | null;
  readonly values: FieldValues;
  readonly items: readonly FieldValues[];
  readonly effort: Effort | null;
  readonly review: ReviewStatus;
  readonly note: string | null;
  readonly strengthSets: number;
  readonly pains: readonly ReportedZonePain[];
  readonly addedBy: string | null;
}

export interface SessionRange {
  readonly from?: LocalDate;
  readonly to?: LocalDate;
}

export function sessionDurationSeconds(row: Pick<Session, "startedAt" | "endedAt" | "pausedSeconds">): number | null {
  if (row.endedAt === null) return null;
  return Math.max(0, Math.round((row.endedAt - row.startedAt) / 1000) - row.pausedSeconds);
}

export function worsePain(left: ReportedPainLevel | null, right: ReportedPainLevel | null): ReportedPainLevel | null {
  if (left === "stop" || right === "stop") return "stop";
  if (left === "discomfort" || right === "discomfort") return "discomfort";
  return null;
}

export function mergeZonePains(pains: readonly ReportedZonePain[]): ReportedZonePain[] {
  const byZone = new Map<ZoneKey, ReportedPainLevel>();
  for (const pain of pains) byZone.set(pain.zone, worsePain(byZone.get(pain.zone) ?? null, pain.level) ?? pain.level);
  return [...byZone.entries()].map(([zone, level]) => ({ zone, level })).sort((left, right) => painRank(right.level) - painRank(left.level));
}

function painRank(level: ReportedPainLevel): number {
  switch (level) {
    case "stop":
      return 2;
    case "discomfort":
      return 1;
    default: {
      const unreachable: never = level;
      throw new Error(`Unhandled pain level ${String(unreachable)}`);
    }
  }
}

export function completedSessions(db: ObnixeDatabase, range: SessionRange = {}): SessionSummary[] {
  const conditions = [eq(session.status, "completed"), isNull(session.deletedAt)];
  if (range.from !== undefined) conditions.push(gte(session.localDate, range.from));
  if (range.to !== undefined) conditions.push(lte(session.localDate, range.to));
  const rows = db
    .select({ session, slotName: programSlot.name, variantName: programVariant.name })
    .from(session)
    .leftJoin(programSlot, eq(session.slotId, programSlot.id))
    .leftJoin(programVariant, eq(session.variantId, programVariant.id))
    .where(and(...conditions))
    .orderBy(asc(session.startedAt))
    .all();
  if (rows.length === 0) return [];
  const ids = rows.map((row) => row.session.id);
  const items = groupBy(
    chunked(ids, (chunk) => db.select({ sessionId: sessionItem.sessionId, values: sessionItem.values }).from(sessionItem).where(inArray(sessionItem.sessionId, chunk)).orderBy(asc(sessionItem.position)).all()),
    (row) => row.sessionId,
  );
  const sets = new Map(
    chunked(ids, (chunk) =>
      db
        .select({ sessionId: strengthEntry.sessionId, count: sql<number>`count(${strengthSet.id})` })
        .from(strengthEntry)
        .innerJoin(strengthSet, eq(strengthSet.entryId, strengthEntry.id))
        .where(inArray(strengthEntry.sessionId, chunk))
        .groupBy(strengthEntry.sessionId)
        .all(),
    ).map((row) => [row.sessionId, Number(row.count)]),
  );
  const pains = groupBy(
    chunked(ids, (chunk) =>
      db
        .select({ sessionId: painReport.sessionId, zone: painReport.zone, level: painReport.level })
        .from(painReport)
        .where(and(inArray(painReport.sessionId, chunk), isNull(painReport.deletedAt), ne(painReport.level, "none")))
        .all(),
    ),
    (row) => row.sessionId ?? "",
  );
  const authors = new Map(
    chunked(ids, (chunk) =>
      db
        .select({ rowId: change.rowId, client: agentConnection.client })
        .from(change)
        .innerJoin(changeset, eq(change.changesetId, changeset.id))
        .innerJoin(agentConnection, eq(changeset.connectionId, agentConnection.id))
        .where(and(eq(change.tableName, "session"), eq(change.operation, "insert"), eq(changeset.author, "agent"), isNotNull(changeset.connectionId), inArray(change.rowId, chunk)))
        .all(),
    ).map((row) => [row.rowId, row.client]),
  );
  return rows.map(({ session: row, slotName, variantName }) => ({
    id: row.id,
    sport: row.sport,
    title: row.title,
    slotName,
    variantName,
    localDate: row.localDate,
    startedAt: row.startedAt,
    durationSeconds: sessionDurationSeconds(row),
    values: row.values,
    items: (items.get(row.id) ?? []).map((item) => item.values),
    effort: row.effort,
    review: row.review,
    note: row.note,
    strengthSets: sets.get(row.id) ?? 0,
    pains: mergeZonePains((pains.get(row.id) ?? []).map((pain) => ({ zone: pain.zone, level: pain.level as ReportedPainLevel }))),
    addedBy: authors.get(row.id) ?? null,
  }));
}

const chunkSize = 500;

export function chunked<T, R>(values: readonly T[], run: (chunk: T[]) => R[]): R[] {
  const results: R[] = [];
  for (let start = 0; start < values.length; start += chunkSize) results.push(...run(values.slice(start, start + chunkSize)));
  return results;
}

export function groupBy<T, K>(values: readonly T[], keyOf: (value: T) => K): Map<K, T[]> {
  const groups = new Map<K, T[]>();
  for (const value of values) {
    const key = keyOf(value);
    const list = groups.get(key);
    if (list === undefined) groups.set(key, [value]);
    else list.push(value);
  }
  return groups;
}
