import { sql } from "drizzle-orm";
import { check, index, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { id, occurred, ref, timestamp, trashable, zone } from "../columns.ts";
import { painLevels, painPhases, zoneTrackingReasons } from "../enums.ts";
import { checkIn } from "./body.ts";
import { session, sessionItem, strengthSet } from "./sessions.ts";

export const painReport = sqliteTable(
  "pain_report",
  {
    id: id(),
    zone: zone("zone").notNull(),
    level: text("level", { enum: painLevels }).notNull(),
    ...occurred(),
    sessionId: ref("session_id").references(() => session.id, { onDelete: "cascade" }),
    phase: text("phase", { enum: painPhases }),
    strengthSetId: ref("strength_set_id").references(() => strengthSet.id, { onDelete: "set null" }),
    sessionItemId: ref("session_item_id").references(() => sessionItem.id, { onDelete: "set null" }),
    checkInId: ref("check_in_id").references(() => checkIn.id, { onDelete: "cascade" }),
    note: text("note"),
    ...trashable(),
  },
  (t) => [
    index("pain_report_zone").on(t.zone, t.occurredAt),
    index("pain_report_session").on(t.sessionId),
    uniqueIndex("pain_report_check_in_zone").on(t.checkInId, t.zone).where(sql`${t.checkInId} IS NOT NULL AND ${t.deletedAt} IS NULL`),
    check(
      "pain_report_source",
      sql`(${t.sessionId} IS NOT NULL AND ${t.phase} IS NOT NULL AND ${t.checkInId} IS NULL) OR (${t.sessionId} IS NULL AND ${t.phase} IS NULL AND ${t.strengthSetId} IS NULL AND ${t.sessionItemId} IS NULL AND ${t.checkInId} IS NOT NULL)`,
    ),
    check("pain_report_anchor", sql`${t.strengthSetId} IS NULL OR ${t.sessionItemId} IS NULL`),
    check("pain_report_anchor_phase", sql`(${t.strengthSetId} IS NULL AND ${t.sessionItemId} IS NULL) OR ${t.phase} IN ('during', 'between')`),
  ],
);

export const zoneTracking = sqliteTable(
  "zone_tracking",
  {
    id: id(),
    zone: zone("zone").notNull(),
    reason: text("reason", { enum: zoneTrackingReasons }).notNull(),
    painReportId: ref("pain_report_id").references(() => painReport.id, { onDelete: "set null" }),
    startedAt: timestamp("started_at").notNull(),
    endedAt: timestamp("ended_at"),
  },
  (t) => [
    uniqueIndex("zone_tracking_open").on(t.zone).where(sql`${t.endedAt} IS NULL`),
    check("zone_tracking_interval", sql`${t.endedAt} IS NULL OR ${t.endedAt} >= ${t.startedAt}`),
    check("zone_tracking_origin", sql`${t.painReportId} IS NULL OR ${t.reason} = 'pain_reported'`),
  ],
);
