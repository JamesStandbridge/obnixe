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
  readonly strengthSetId: Id | null;
  readonly occurredAt: EpochMs;
  readonly timeZone: string;
}

export interface PainReportRequest extends SessionPainContext {
  readonly newId: () => Id;
  readonly levels: ReadonlyMap<ZoneKey, PainLevel>;
  readonly tracked: readonly ZoneKey[];
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

export function painReportMutations(request: PainReportRequest): PainPlan {
  const tracked = new Set(request.tracked);
  const localDate = localDateOf(request.occurredAt, request.timeZone);
  const reportIds: Id[] = [];
  const mutations: Mutation[] = [];
  for (const [zone, level] of request.levels) {
    const reportId = request.newId();
    reportIds.push(reportId);
    mutations.push({
      kind: "insert",
      table: "pain_report",
      row: {
        id: reportId,
        zone,
        level,
        occurredAt: request.occurredAt,
        localDate,
        timeZone: request.timeZone,
        sessionId: request.sessionId,
        phase: request.phase,
        strengthSetId: request.strengthSetId,
        sessionItemId: request.sessionItemId,
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
        row: { id: request.newId(), zone, reason: "pain_reported", painReportId: reportId, startedAt: request.occurredAt, endedAt: null },
      });
    }
  }
  return { reportIds, mutations };
}

export function sessionPainMutations(db: ObnixeDatabase, env: Environment, context: SessionPainContext, pains: readonly ZonePain[]): PainPlan {
  return painReportMutations({ ...context, newId: env.newId, levels: new Map(pains.map((pain) => [pain.zone, pain.level])), tracked: trackedZones(db) });
}
