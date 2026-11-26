import { and, eq, inArray, isNull, ne } from "drizzle-orm";
import { bestEffort, session } from "@obnixe/schema";
import type { BestEffort, BestEffortKey, EpochMs, Id } from "@obnixe/schema";
import type { ObnixeDatabase } from "../database.ts";

export type AnnouncedRank = 1 | 2 | 3;

export interface EffortResult {
  readonly elapsedMs: number;
  /** Set for an `ascent_1h` effort only. */
  readonly ascentMm: number | null;
}

export interface RecordAnnouncement extends EffortResult {
  readonly effort: BestEffortKey;
  /** 1 for a new personal record, 2 or 3 for the next best results. */
  readonly rank: AnnouncedRank;
  /** The best of the other kept activities: beaten by a record, still ahead otherwise; null for a first effort of this kind. */
  readonly best: EffortResult | null;
}

interface Ranked extends EffortResult {
  readonly effort: BestEffortKey;
  readonly startedAt: EpochMs;
}

const isAscentEffort = (effort: BestEffortKey): boolean => effort.endsWith(":ascent_1h");

/** Higher is better: the ascent of an `ascent_1h` effort, the opposite of the time of a distance effort. */
function scoreOf(row: Pick<BestEffort, "effort" | "elapsedMs" | "ascentMm">): number {
  return isAscentEffort(row.effort) ? (row.ascentMm ?? 0) : -row.elapsedMs;
}

/** Distance efforts by increasing distance, the ascent window last. */
function effortOrder(effort: BestEffortKey): number {
  if (isAscentEffort(effort)) return Number.POSITIVE_INFINITY;
  return Number(effort.split(":")[2]);
}

/**
 * `PR-004`: where each best effort of the saved `sessionId` ranks among the kept activities, for the ones on the podium. A tie
 * goes to the activity started first, so an equalled record is announced second. Derived from `best_effort` (`PR-003`).
 */
export function recordAnnouncements(db: ObnixeDatabase, sessionId: Id): readonly RecordAnnouncement[] {
  const own = db
    .select({ effort: bestEffort.effort, elapsedMs: bestEffort.elapsedMs, ascentMm: bestEffort.ascentMm, startedAt: session.startedAt })
    .from(bestEffort)
    .innerJoin(session, eq(bestEffort.sessionId, session.id))
    .where(and(eq(bestEffort.sessionId, sessionId), isNull(session.deletedAt)))
    .all();
  if (own.length === 0) return [];
  const others = db
    .select({ effort: bestEffort.effort, elapsedMs: bestEffort.elapsedMs, ascentMm: bestEffort.ascentMm, startedAt: session.startedAt })
    .from(bestEffort)
    .innerJoin(session, eq(bestEffort.sessionId, session.id))
    .where(and(inArray(bestEffort.effort, own.map((row) => row.effort)), ne(bestEffort.sessionId, sessionId), isNull(session.deletedAt), eq(session.status, "completed")))
    .all();
  const byEffort = new Map<BestEffortKey, Ranked[]>();
  for (const row of others) byEffort.set(row.effort, [...(byEffort.get(row.effort) ?? []), row]);
  return own
    .flatMap((row): RecordAnnouncement[] => {
      const rivals = byEffort.get(row.effort) ?? [];
      const score = scoreOf(row);
      const ahead = rivals.filter((rival) => scoreOf(rival) > score || (scoreOf(rival) === score && rival.startedAt <= row.startedAt)).length;
      const rank = ahead + 1;
      if (rank !== 1 && rank !== 2 && rank !== 3) return [];
      const best = rivals.reduce<Ranked | null>((leader, rival) => (leader === null || scoreOf(rival) > scoreOf(leader) || (scoreOf(rival) === scoreOf(leader) && rival.startedAt < leader.startedAt) ? rival : leader), null);
      return [{ effort: row.effort, rank, elapsedMs: row.elapsedMs, ascentMm: row.ascentMm, best: best === null ? null : { elapsedMs: best.elapsedMs, ascentMm: best.ascentMm } }];
    })
    .sort((left, right) => effortOrder(left.effort) - effortOrder(right.effort));
}
