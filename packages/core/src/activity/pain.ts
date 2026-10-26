import { and, desc, eq, isNull, ne } from "drizzle-orm";
import { painReport, zoneTracking } from "@obnixe/schema";
import type { EpochMs, Id, LocalDate, PainLevel, PainPhase, ZoneKey } from "@obnixe/schema";
import type { Environment, ObnixeDatabase } from "../database.ts";
import type { Mutation } from "../writer.ts";
import { localDateOf } from "./dates.ts";

export interface ZonePain {
  readonly zone: ZoneKey;
  readonly level: PainLevel;
}

export interface SessionPainContext {
  readonly sessionId: Id;
  readonly phase: PainPhase;
  readonly sessionItemId: Id | null;
  readonly occurredAt: EpochMs;
  readonly timeZone: string;
}

export interface PainPlan {
  readonly reportIds: readonly Id[];
  readonly mutations: readonly Mutation[];
}

export interface LastPain {
  readonly level: Exclude<PainLevel, "none">;
  readonly localDate: LocalDate;
}

export interface ZoneStatus {
  readonly zone: ZoneKey;
  readonly tracked: boolean;
  readonly last: LastPain | null;
}

export function trackedZones(db: ObnixeDatabase): ZoneKey[] {
  return db
    .select({ zone: zoneTracking.zone })
    .from(zoneTracking)
    .where(isNull(zoneTracking.endedAt))
    .orderBy(zoneTracking.startedAt)
    .all()
    .map((row) => row.zone);
}

export function lastPain(db: ObnixeDatabase, zone: ZoneKey): LastPain | null {
  const row = db
    .select({ level: painReport.level, localDate: painReport.localDate })
    .from(painReport)
    .where(and(eq(painReport.zone, zone), ne(painReport.level, "none"), isNull(painReport.deletedAt)))
    .orderBy(desc(painReport.occurredAt))
    .get();
  if (row === undefined || row.level === "none") return null;
  return { level: row.level, localDate: row.localDate };
}

export function zoneStatuses(db: ObnixeDatabase, zones: readonly ZoneKey[]): ZoneStatus[] {
  const tracked = new Set(trackedZones(db));
  return zones.map((zone) => ({ zone, tracked: tracked.has(zone), last: lastPain(db, zone) }));
}

export function sessionPainMutations(db: ObnixeDatabase, env: Environment, context: SessionPainContext, pains: readonly ZonePain[]): PainPlan {
  const tracked = new Set(trackedZones(db));
  const localDate = localDateOf(context.occurredAt, context.timeZone);
  const byZone = new Map(pains.map((pain) => [pain.zone, pain.level]));
  const reportIds: Id[] = [];
  const mutations: Mutation[] = [];
  for (const [zone, level] of byZone) {
    const reportId = env.newId();
    reportIds.push(reportId);
    mutations.push({
      kind: "insert",
      table: "pain_report",
      row: {
        id: reportId,
        zone,
        level,
        occurredAt: context.occurredAt,
        localDate,
        timeZone: context.timeZone,
        sessionId: context.sessionId,
        phase: context.phase,
        strengthSetId: null,
        sessionItemId: context.sessionItemId,
        checkInId: null,
        note: null,
        deletedAt: null,
      },
    });
    if (level !== "none" && !tracked.has(zone)) {
      tracked.add(zone);
      mutations.push({
        kind: "insert",
        table: "zone_tracking",
        row: { id: env.newId(), zone, reason: "pain_reported", painReportId: reportId, startedAt: context.occurredAt, endedAt: null },
      });
    }
  }
  return { reportIds, mutations };
}
