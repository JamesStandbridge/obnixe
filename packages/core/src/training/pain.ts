import { and, asc, isNull, lte } from "drizzle-orm";
import { painReport, zoneTracking } from "@obnixe/schema";
import type { EpochMs, Id, LocalDate, PainLevel, PainPhase, PainReport, ZoneKey } from "@obnixe/schema";
import type { ObnixeDatabase } from "../database.ts";
import type { Mutation } from "../writer.ts";

export function isPainful(level: PainLevel | null | undefined): boolean {
  return level === "discomfort" || level === "stop";
}

export function worstLevel(levels: readonly PainLevel[]): Exclude<PainLevel, "none"> | null {
  if (levels.includes("stop")) return "stop";
  if (levels.includes("discomfort")) return "discomfort";
  return null;
}

export function latestPainByZone(db: ObnixeDatabase, until: EpochMs): ReadonlyMap<ZoneKey, PainReport> {
  const reports = db
    .select()
    .from(painReport)
    .where(and(isNull(painReport.deletedAt), lte(painReport.occurredAt, until)))
    .orderBy(asc(painReport.occurredAt))
    .all();
  const latest = new Map<ZoneKey, PainReport>();
  for (const report of reports) latest.set(report.zone, report);
  return latest;
}

export function trackedZones(db: ObnixeDatabase): readonly ZoneKey[] {
  return db
    .select({ zone: zoneTracking.zone })
    .from(zoneTracking)
    .where(isNull(zoneTracking.endedAt))
    .orderBy(asc(zoneTracking.startedAt))
    .all()
    .map((row) => row.zone);
}

export function painfulZones(zones: readonly ZoneKey[], latest: ReadonlyMap<ZoneKey, Pick<PainReport, "level">>): readonly ZoneKey[] {
  return zones.filter((zone) => isPainful(latest.get(zone)?.level));
}

export function stoppedZones(zones: readonly ZoneKey[], latest: ReadonlyMap<ZoneKey, Pick<PainReport, "level">>): readonly ZoneKey[] {
  return zones.filter((zone) => latest.get(zone)?.level === "stop");
}

export interface SessionPainRequest {
  readonly newId: () => Id;
  readonly sessionId: Id;
  readonly phase: PainPhase;
  readonly strengthSetId: Id | null;
  readonly occurredAt: EpochMs;
  readonly localDate: LocalDate;
  readonly timeZone: string;
  readonly levels: ReadonlyMap<ZoneKey, PainLevel>;
  readonly tracked: readonly ZoneKey[];
}

export function sessionPainMutations(request: SessionPainRequest): Mutation[] {
  const mutations: Mutation[] = [];
  for (const [zone, level] of request.levels) {
    const id = request.newId();
    mutations.push({
      kind: "insert",
      table: "pain_report",
      row: {
        id,
        zone,
        level,
        occurredAt: request.occurredAt,
        localDate: request.localDate,
        timeZone: request.timeZone,
        sessionId: request.sessionId,
        phase: request.phase,
        strengthSetId: request.strengthSetId,
        sessionItemId: null,
        checkInId: null,
        note: null,
        deletedAt: null,
      },
    });
    if (isPainful(level) && !request.tracked.includes(zone)) {
      mutations.push({
        kind: "insert",
        table: "zone_tracking",
        row: { id: request.newId(), zone, reason: "pain_reported", painReportId: id, startedAt: request.occurredAt, endedAt: null },
      });
    }
  }
  return mutations;
}
