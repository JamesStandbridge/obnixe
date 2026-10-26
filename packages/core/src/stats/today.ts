import { and, asc, desc, eq, gt, gte, inArray, isNull, ne, sql } from "drizzle-orm";
import { agentConnection, changeset, exercise, exerciseZone, painReport, programItem, programSlot, programVariant, session, sessionItem, strengthEntry, strengthSet, zoneTracking } from "@obnixe/schema";
import type { EpochMs, ExerciseMeasure, Id, LocalDate, PainLevel, ProgramItem, ProgramSlot, Session, SportKey, ZoneKey } from "@obnixe/schema";
import type { ObnixeDatabase } from "../database.ts";
import type { Mutation } from "../writer.ts";
import { addDays } from "../dates.ts";
import type { LocalTime } from "../dates.ts";
import { lastPerformances } from "./exercise.ts";
import type { LastPerformance } from "./exercise.ts";
import { groupBy } from "./sessions.ts";
import type { ReportedPainLevel } from "./sessions.ts";

export interface OpenSession {
  readonly session: Session;
  readonly slotName: string | null;
  readonly variantName: string | null;
  readonly setCount: number;
  readonly itemCount: number;
  readonly lastActivityAt: EpochMs;
}

export function openSession(db: ObnixeDatabase): OpenSession | null {
  const row = db
    .select({ session, slotName: programSlot.name, variantName: programVariant.name })
    .from(session)
    .leftJoin(programSlot, eq(session.slotId, programSlot.id))
    .leftJoin(programVariant, eq(session.variantId, programVariant.id))
    .where(and(ne(session.status, "completed"), isNull(session.deletedAt)))
    .orderBy(desc(session.startedAt))
    .get();
  if (row === undefined) return null;
  const sets = db
    .select({ count: sql<number>`count(*)`, last: sql<EpochMs | null>`max(${strengthSet.completedAt})` })
    .from(strengthSet)
    .innerJoin(strengthEntry, eq(strengthSet.entryId, strengthEntry.id))
    .where(eq(strengthEntry.sessionId, row.session.id))
    .get();
  const items = db
    .select({ count: sql<number>`count(*)`, last: sql<EpochMs | null>`max(${sessionItem.recordedAt})` })
    .from(sessionItem)
    .where(eq(sessionItem.sessionId, row.session.id))
    .get();
  const candidates = [row.session.endedAt ?? row.session.startedAt, sets?.last ?? null, items?.last ?? null].filter((value): value is EpochMs => value !== null);
  return {
    session: row.session,
    slotName: row.slotName,
    variantName: row.variantName,
    setCount: Number(sets?.count ?? 0),
    itemCount: Number(items?.count ?? 0),
    lastActivityAt: Math.max(...candidates.map(Number)) as EpochMs,
  };
}

export function finishOpenSessionMutations(open: OpenSession): Mutation[] {
  const endedAt = open.session.endedAt ?? (Math.max(open.lastActivityAt, open.session.startedAt) as EpochMs);
  return [{ kind: "update", table: "session", key: open.session.id, patch: { status: "completed", endedAt, review: "pending" } }];
}

export const resumeUntilMinutes = 6 * 60;

export function resumeDeadlineDate(lastActivity: LocalTime): LocalDate {
  return lastActivity.minutes < resumeUntilMinutes ? lastActivity.date : addDays(lastActivity.date, 1);
}

export interface PainCarry {
  readonly zone: ZoneKey;
  readonly level: ReportedPainLevel;
  readonly localDate: LocalDate;
}

export interface AgentChanges {
  readonly count: number;
  readonly latestAt: EpochMs;
  readonly client: string | null;
}

export interface PendingReview {
  readonly sessionId: Id;
  readonly sport: SportKey;
  readonly localDate: LocalDate;
  readonly title: string | null;
  readonly slotName: string | null;
}

export interface TodayNotices {
  readonly pains: readonly PainCarry[];
  readonly agent: AgentChanges | null;
  readonly reviews: readonly PendingReview[];
}

export interface NoticeOptions {
  readonly today: LocalDate;
  readonly agentChangesSeenAt: EpochMs | null;
  readonly painWindowDays?: number;
}

interface ZoneReport {
  readonly zone: ZoneKey;
  readonly level: PainLevel;
  readonly localDate: LocalDate;
  readonly occurredAt: EpochMs;
  readonly checkInId: Id | null;
}

function recentReports(db: ObnixeDatabase, from: LocalDate): ZoneReport[] {
  return db
    .select({ zone: painReport.zone, level: painReport.level, localDate: painReport.localDate, occurredAt: painReport.occurredAt, checkInId: painReport.checkInId })
    .from(painReport)
    .leftJoin(session, eq(painReport.sessionId, session.id))
    .where(and(isNull(painReport.deletedAt), gte(painReport.localDate, from), isNull(session.deletedAt)))
    .orderBy(asc(painReport.occurredAt))
    .all();
}

export function painCarries(db: ObnixeDatabase, today: LocalDate, windowDays: number): PainCarry[] {
  const latest = new Map<ZoneKey, ZoneReport>();
  for (const report of recentReports(db, addDays(today, -(windowDays - 1)))) latest.set(report.zone, report);
  return [...latest.values()]
    .flatMap((report) => (report.level === "none" ? [] : [{ zone: report.zone, level: report.level, localDate: report.localDate }]))
    .sort((left, right) => (left.level === right.level ? right.localDate.localeCompare(left.localDate) : left.level === "stop" ? -1 : 1));
}

export function agentChangesSince(db: ObnixeDatabase, since: EpochMs | null): AgentChanges | null {
  const reverted = db.select({ id: changeset.revertsId }).from(changeset).where(sql`${changeset.revertsId} IS NOT NULL`).all();
  const revertedIds = new Set(reverted.map((row) => row.id));
  const rows = db
    .select({ id: changeset.id, createdAt: changeset.createdAt, revertsId: changeset.revertsId, client: agentConnection.client })
    .from(changeset)
    .leftJoin(agentConnection, eq(changeset.connectionId, agentConnection.id))
    .where(and(eq(changeset.author, "agent"), gt(changeset.createdAt, since ?? (0 as EpochMs))))
    .orderBy(desc(changeset.createdAt))
    .all()
    .filter((row) => row.revertsId === null && !revertedIds.has(row.id));
  const latest = rows[0];
  if (latest === undefined) return null;
  return { count: rows.length, latestAt: latest.createdAt, client: latest.client };
}

export function pendingReviews(db: ObnixeDatabase): PendingReview[] {
  return db
    .select({ sessionId: session.id, sport: session.sport, localDate: session.localDate, title: session.title, slotName: programSlot.name })
    .from(session)
    .leftJoin(programSlot, eq(session.slotId, programSlot.id))
    .where(and(eq(session.status, "completed"), eq(session.review, "pending"), isNull(session.deletedAt)))
    .orderBy(desc(session.startedAt))
    .all();
}

export function todayNotices(db: ObnixeDatabase, options: NoticeOptions): TodayNotices {
  return {
    pains: painCarries(db, options.today, options.painWindowDays ?? 3),
    agent: agentChangesSince(db, options.agentChangesSeenAt),
    reviews: pendingReviews(db),
  };
}

export interface PlanItem {
  readonly itemId: Id;
  readonly exerciseId: Id;
  readonly name: string;
  readonly measure: ExerciseMeasure;
  readonly sets: number;
  readonly repsMin: number | null;
  readonly repsMax: number | null;
  readonly durationMinSeconds: number | null;
  readonly durationMaxSeconds: number | null;
  readonly restSeconds: number | null;
  readonly restAfterSeconds: number | null;
  readonly zones: readonly ZoneKey[];
  readonly last: LastPerformance | null;
}

export function variantPlan(db: ObnixeDatabase, variantId: Id): PlanItem[] {
  const rows = db
    .select({ item: programItem, name: exercise.name, measure: exercise.measure })
    .from(programItem)
    .innerJoin(exercise, eq(programItem.exerciseId, exercise.id))
    .where(eq(programItem.variantId, variantId))
    .orderBy(asc(programItem.position))
    .all();
  const exerciseIds = rows.map((row) => row.item.exerciseId);
  const zones = groupBy(exerciseIds.length === 0 ? [] : db.select().from(exerciseZone).where(inArray(exerciseZone.exerciseId, exerciseIds)).all(), (row) => row.exerciseId);
  const last = lastPerformances(db, exerciseIds);
  return rows.map(({ item, name, measure }) => ({
    itemId: item.id,
    exerciseId: item.exerciseId,
    name,
    measure,
    sets: item.sets,
    repsMin: item.repsMin,
    repsMax: item.repsMax,
    durationMinSeconds: item.durationMinSeconds,
    durationMaxSeconds: item.durationMaxSeconds,
    restSeconds: item.restSeconds,
    restAfterSeconds: item.restAfterSeconds,
    zones: (zones.get(item.exerciseId) ?? []).map((row) => row.zone),
    last: last.get(item.exerciseId) ?? null,
  }));
}

const secondsPerRep = 4;
const defaultRestSeconds = 120;
const defaultTransitionSeconds = 60;
const warmupSeconds = 300;

type EstimableItem = Pick<ProgramItem, "sets" | "repsMin" | "repsMax" | "durationMinSeconds" | "durationMaxSeconds" | "restSeconds" | "restAfterSeconds">;

export function estimatedSlotSeconds(slot: Pick<ProgramSlot, "targetDurationSeconds">, items: readonly EstimableItem[]): number | null {
  if (slot.targetDurationSeconds !== null) return slot.targetDurationSeconds;
  if (items.length === 0) return null;
  const total = items.reduce((sum, item) => {
    const work = item.repsMin !== null ? ((item.repsMin + (item.repsMax ?? item.repsMin)) / 2) * secondsPerRep : ((item.durationMinSeconds ?? 0) + (item.durationMaxSeconds ?? item.durationMinSeconds ?? 0)) / 2;
    const rest = item.restSeconds ?? defaultRestSeconds;
    return sum + item.sets * work + (item.sets - 1) * rest + (item.restAfterSeconds ?? defaultTransitionSeconds);
  }, warmupSeconds);
  return Math.round(total / 300) * 300;
}

export interface TrackedZone {
  readonly zone: ZoneKey;
  readonly latest: { readonly level: ReportedPainLevel; readonly localDate: LocalDate } | null;
  readonly todayLevel: PainLevel | null;
  readonly todayReportId: Id | null;
}

export interface TrackedZoneOptions {
  readonly today: LocalDate;
  readonly checkInId: Id | null;
  readonly recentDays?: number;
}

export function checkInZones(db: ObnixeDatabase, options: TrackedZoneOptions): TrackedZone[] {
  const open = db.select({ zone: zoneTracking.zone }).from(zoneTracking).where(isNull(zoneTracking.endedAt)).orderBy(asc(zoneTracking.startedAt)).all();
  const reports = recentReports(db, addDays(options.today, -((options.recentDays ?? 7) - 1)));
  const todays =
    options.checkInId === null
      ? []
      : db
          .select({ id: painReport.id, zone: painReport.zone, level: painReport.level })
          .from(painReport)
          .where(and(eq(painReport.checkInId, options.checkInId), isNull(painReport.deletedAt)))
          .all();
  const zones: ZoneKey[] = open.map((row) => row.zone);
  for (const report of [...reports].reverse()) if (report.level !== "none" && !zones.includes(report.zone)) zones.push(report.zone);
  for (const report of todays) if (!zones.includes(report.zone)) zones.push(report.zone);
  const tracked: TrackedZone[] = zones.map((zone) => {
    const earlier = reports.filter((report) => report.zone === zone && report.level !== "none" && !(options.checkInId !== null && report.checkInId === options.checkInId));
    const latest = earlier[earlier.length - 1];
    const todayReport = todays.find((report) => report.zone === zone);
    return {
      zone,
      latest: latest === undefined || latest.level === "none" ? null : { level: latest.level, localDate: latest.localDate },
      todayLevel: todayReport?.level ?? null,
      todayReportId: todayReport?.id ?? null,
    };
  });
  return tracked.sort((left, right) => severity(right) - severity(left));
}

function severity(zone: TrackedZone): number {
  const level = zone.latest?.level;
  switch (level) {
    case "stop":
      return 2;
    case "discomfort":
      return 1;
    case undefined:
      return 0;
    default: {
      const unreachable: never = level;
      throw new Error(`Unhandled pain level ${String(unreachable)}`);
    }
  }
}
