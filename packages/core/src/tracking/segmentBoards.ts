import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { segment, segmentEffort, session } from "@obnixe/schema";
import type { EpochMs, Id, LocalDate, Segment, SegmentFamily, SportKey } from "@obnixe/schema";
import type { ObnixeDatabase } from "../database.ts";

/** One pass over a segment by an activity in force, with what the segment screen links to. */
export interface SegmentEffortEntry {
  readonly segmentId: Id;
  readonly sessionId: Id;
  readonly occurrence: number;
  readonly startedAt: EpochMs;
  readonly localDate: LocalDate;
  readonly title: string | null;
  readonly sport: SportKey;
  readonly startOffsetMs: number;
  readonly elapsedMs: number;
  readonly movingMs: number;
  readonly heartRateAvg: number | null;
}

export type SegmentTrend = "faster" | "steady" | "slower";

/** `SEG-003`: the mean of the last efforts against the mean of as many before them, beyond 2 % either way. */
export const segmentTrendRules = { window: 3, threshold: 0.02 } as const;

/** Best, last, count and trend of a segment over the activities in force (`SEG-003`); never stored. */
export interface SegmentStanding {
  readonly best: SegmentEffortEntry | null;
  readonly last: SegmentEffortEntry | null;
  readonly count: number;
  readonly trend: SegmentTrend | null;
}

export interface SegmentBoard extends SegmentStanding {
  readonly segment: Segment;
  /** Fastest first. */
  readonly ranked: readonly SegmentEffortEntry[];
}

export interface SegmentSummary extends SegmentStanding {
  readonly segment: Segment;
}

/** A pass of one activity, ranked among every effort in force on its segment. */
export interface SessionSegmentEffort {
  readonly segment: Segment;
  readonly occurrence: number;
  readonly startOffsetMs: number;
  readonly elapsedMs: number;
  readonly movingMs: number;
  readonly heartRateAvg: number | null;
  /** From 1; an earlier effort keeps the better rank on a tie. */
  readonly rank: number;
  readonly count: number;
  readonly bestElapsedMs: number;
}

const entryColumns = {
  segmentId: segmentEffort.segmentId,
  sessionId: segmentEffort.sessionId,
  occurrence: segmentEffort.occurrence,
  startedAt: session.startedAt,
  localDate: session.localDate,
  title: session.title,
  sport: session.sport,
  startOffsetMs: segmentEffort.startOffsetMs,
  elapsedMs: segmentEffort.elapsedMs,
  movingMs: segmentEffort.movingMs,
  heartRateAvg: segmentEffort.heartRateAvg,
};

/** Efforts of the completed sessions outside the trash on these segments, in the order they were made. */
function effortEntries(db: ObnixeDatabase, segmentIds: readonly Id[]): readonly SegmentEffortEntry[] {
  if (segmentIds.length === 0) return [];
  return db
    .select(entryColumns)
    .from(segmentEffort)
    .innerJoin(session, eq(segmentEffort.sessionId, session.id))
    .where(and(inArray(segmentEffort.segmentId, [...new Set(segmentIds)]), isNull(session.deletedAt), eq(session.status, "completed")))
    .orderBy(asc(session.startedAt), asc(segmentEffort.startOffsetMs), asc(session.id))
    .all();
}

const madeAt = (entry: Pick<SegmentEffortEntry, "startedAt" | "startOffsetMs">): number => entry.startedAt + entry.startOffsetMs;

/** Faster first; the earlier effort wins a tie. */
function byTime(left: SegmentEffortEntry, right: SegmentEffortEntry): number {
  return left.elapsedMs - right.elapsedMs || madeAt(left) - madeAt(right) || left.sessionId.localeCompare(right.sessionId) || left.occurrence - right.occurrence;
}

const mean = (values: readonly number[]): number => values.reduce((sum, value) => sum + value, 0) / values.length;

export function segmentTrend(chronological: readonly Pick<SegmentEffortEntry, "elapsedMs">[]): SegmentTrend | null {
  const size = Math.min(segmentTrendRules.window, Math.floor(chronological.length / 2));
  if (size === 0) return null;
  const times = chronological.map((entry) => entry.elapsedMs);
  const recent = mean(times.slice(-size));
  const before = mean(times.slice(-2 * size, -size));
  if (recent < before * (1 - segmentTrendRules.threshold)) return "faster";
  if (recent > before * (1 + segmentTrendRules.threshold)) return "slower";
  return "steady";
}

function standingOf(chronological: readonly SegmentEffortEntry[]): SegmentStanding {
  return {
    best: chronological.reduce<SegmentEffortEntry | null>((best, entry) => (best === null || byTime(entry, best) < 0 ? entry : best), null),
    last: chronological.at(-1) ?? null,
    count: chronological.length,
    trend: segmentTrend(chronological),
  };
}

function groupBySegment(entries: readonly SegmentEffortEntry[]): ReadonlyMap<Id, readonly SegmentEffortEntry[]> {
  const groups = new Map<Id, SegmentEffortEntry[]>();
  for (const entry of entries) {
    const group = groups.get(entry.segmentId);
    if (group === undefined) groups.set(entry.segmentId, [entry]);
    else group.push(entry);
  }
  return groups;
}

/** The segment screen (`SEG-003`), trashed segments included so the screen can say so; `null` for an unknown id. */
export function segmentBoard(db: ObnixeDatabase, segmentId: Id): SegmentBoard | null {
  const row = db.select().from(segment).where(eq(segment.id, segmentId)).get();
  if (row === undefined) return null;
  const chronological = effortEntries(db, [segmentId]);
  return { segment: row, ...standingOf(chronological), ranked: [...chronological].sort(byTime) };
}

/** The segments of a family outside the trash, by name. */
export function segmentSummaries(db: ObnixeDatabase, family: SegmentFamily): readonly SegmentSummary[] {
  const rows = db
    .select()
    .from(segment)
    .where(and(eq(segment.family, family), isNull(segment.deletedAt)))
    .all()
    .sort((left, right) => left.name.localeCompare(right.name));
  const groups = groupBySegment(
    effortEntries(
      db,
      rows.map((row) => row.id),
    ),
  );
  return rows.map((row) => ({ segment: row, ...standingOf(groups.get(row.id) ?? []) }));
}

/** The passes of an activity over segments outside the trash, in track order, each ranked on its segment (`SEG-003`). */
export function sessionSegmentEfforts(db: ObnixeDatabase, sessionId: Id): readonly SessionSegmentEffort[] {
  const own = db
    .select({ segment, entry: entryColumns })
    .from(segmentEffort)
    .innerJoin(segment, eq(segment.id, segmentEffort.segmentId))
    .innerJoin(session, eq(session.id, segmentEffort.sessionId))
    .where(and(eq(segmentEffort.sessionId, sessionId), isNull(segment.deletedAt)))
    .orderBy(asc(segmentEffort.startOffsetMs))
    .all();
  const groups = groupBySegment(
    effortEntries(
      db,
      own.map((row) => row.segment.id),
    ),
  );
  return own.map(({ segment: row, entry }): SessionSegmentEffort => {
    const others = (groups.get(row.id) ?? []).filter((other) => other.sessionId !== sessionId || other.occurrence !== entry.occurrence);
    const all = [...others, entry];
    return {
      segment: row,
      occurrence: entry.occurrence,
      startOffsetMs: entry.startOffsetMs,
      elapsedMs: entry.elapsedMs,
      movingMs: entry.movingMs,
      heartRateAvg: entry.heartRateAvg,
      rank: 1 + others.filter((other) => byTime(other, entry) < 0).length,
      count: all.length,
      bestElapsedMs: Math.min(...all.map((item) => item.elapsedMs)),
    };
  });
}
