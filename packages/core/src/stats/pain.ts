import { and, asc, eq, inArray, isNull, ne } from "drizzle-orm";
import { painReport, session } from "@obnixe/schema";
import type { LocalDate, ZoneKey } from "@obnixe/schema";
import type { ObnixeDatabase } from "../database.ts";
import type { ReportedPainLevel } from "./sessions.ts";

export type PainSource = "session" | "check_in";

export interface ZonePainEvent {
  readonly zone: ZoneKey;
  readonly localDate: LocalDate;
  readonly level: ReportedPainLevel;
  readonly source: PainSource;
}

export function zonePainHistory(db: ObnixeDatabase, zones: readonly ZoneKey[]): ZonePainEvent[] {
  if (zones.length === 0) return [];
  return db
    .select({ zone: painReport.zone, localDate: painReport.localDate, level: painReport.level, sessionId: painReport.sessionId })
    .from(painReport)
    .leftJoin(session, eq(painReport.sessionId, session.id))
    .where(and(inArray(painReport.zone, [...zones]), ne(painReport.level, "none"), isNull(painReport.deletedAt), isNull(session.deletedAt)))
    .orderBy(asc(painReport.occurredAt))
    .all()
    .map((row) => ({ zone: row.zone, localDate: row.localDate, level: row.level as ReportedPainLevel, source: row.sessionId === null ? "check_in" : "session" }));
}
