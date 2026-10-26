import { and, asc, isNull, lte } from "drizzle-orm";
import { painReport } from "@obnixe/schema";
import type { EpochMs, PainLevel, PainReport, ZoneKey } from "@obnixe/schema";
import type { ObnixeDatabase } from "../database.ts";

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

export function painfulZones(zones: readonly ZoneKey[], latest: ReadonlyMap<ZoneKey, Pick<PainReport, "level">>): readonly ZoneKey[] {
  return zones.filter((zone) => isPainful(latest.get(zone)?.level));
}

export function stoppedZones(zones: readonly ZoneKey[], latest: ReadonlyMap<ZoneKey, Pick<PainReport, "level">>): readonly ZoneKey[] {
  return zones.filter((zone) => latest.get(zone)?.level === "stop");
}
