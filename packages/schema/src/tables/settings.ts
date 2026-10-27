import { sql } from "drizzle-orm";
import { check, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { id, timestamp } from "../columns.ts";
import { backupKinds, massUnits, themes } from "../enums.ts";

export const settings = sqliteTable(
  "settings",
  {
    singleton: integer("singleton").primaryKey(),
    theme: text("theme", { enum: themes }).notNull(),
    massUnit: text("mass_unit", { enum: massUnits }).notNull(),
    agentCanReadBody: integer("agent_can_read_body", { mode: "boolean" }).notNull(),
    agentCanWrite: integer("agent_can_write", { mode: "boolean" }).notNull(),
    agentCanReadPhotos: integer("agent_can_read_photos", { mode: "boolean" }).notNull(),
    reminderWeekdays: integer("reminder_weekdays").notNull(),
    reminderMinutes: integer("reminder_minutes").notNull(),
    remindersExportedAt: timestamp("reminders_exported_at"),
    agentChangesSeenAt: timestamp("agent_changes_seen_at"),
    bridgeHost: text("bridge_host"),
    restAlertsDeclinedAt: timestamp("rest_alerts_declined_at"),
    restAlertsAskedAt: timestamp("rest_alerts_asked_at"),
    updatedAt: timestamp("updated_at").notNull(),
  },
  (t) => [
    check("settings_singleton", sql`${t.singleton} = 1`),
    check("settings_reminder_weekdays", sql`${t.reminderWeekdays} BETWEEN 0 AND 127`),
    check("settings_reminder_minutes", sql`${t.reminderMinutes} BETWEEN 0 AND 1439`),
  ],
);

export const backup = sqliteTable("backup", {
  id: id(),
  kind: text("kind", { enum: backupKinds }).notNull(),
  schemaVersion: integer("schema_version").notNull(),
  catalogVersion: integer("catalog_version").notNull(),
  includesPhotos: integer("includes_photos", { mode: "boolean" }).notNull(),
  sizeBytes: integer("size_bytes").notNull(),
  coveredFrom: timestamp("covered_from"),
  coveredTo: timestamp("covered_to"),
  snapshotFile: text("snapshot_file"),
  createdAt: timestamp("created_at").notNull(),
});
