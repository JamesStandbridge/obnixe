import { sql } from "drizzle-orm";
import { check, index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import type { AnySQLiteColumn } from "drizzle-orm/sqlite-core";
import { id, ref, timestamp, tracked, zone } from "../columns.ts";
import { equipments, exerciseMeasures, loadModes } from "../enums.ts";

export const exercise = sqliteTable(
  "exercise",
  {
    id: id(),
    name: text("name").notNull(),
    nameKey: text("name_key").notNull(),
    measure: text("measure", { enum: exerciseMeasures }).notNull(),
    equipment: text("equipment", { enum: equipments }).notNull(),
    loadMode: text("load_mode", { enum: loadModes }).notNull(),
    baseGrams: integer("base_grams"),
    loadStepGrams: integer("load_step_grams"),
    zonesReviewed: integer("zones_reviewed", { mode: "boolean" }).notNull(),
    mergedIntoId: ref("merged_into_id").references((): AnySQLiteColumn => exercise.id),
    archivedAt: timestamp("archived_at"),
    ...tracked(),
  },
  (t) => [
    uniqueIndex("exercise_name_key").on(t.nameKey).where(sql`${t.mergedIntoId} IS NULL`),
    check("exercise_merged", sql`${t.mergedIntoId} IS NULL OR (${t.mergedIntoId} <> ${t.id} AND ${t.archivedAt} IS NOT NULL)`),
    check("exercise_load_step", sql`${t.loadStepGrams} IS NULL OR (${t.measure} <> 'duration' AND ${t.loadStepGrams} > 0)`),
    check("exercise_load_mode", sql`${t.loadMode} = 'total' OR ${t.measure} <> 'duration'`),
    check("exercise_base", sql`${t.baseGrams} IS NULL OR (${t.loadMode} = 'per_side' AND ${t.baseGrams} > 0)`),
  ],
);

export const exerciseZone = sqliteTable(
  "exercise_zone",
  {
    exerciseId: ref("exercise_id").notNull().references(() => exercise.id, { onDelete: "cascade" }),
    zone: zone("zone").notNull(),
  },
  (t) => [primaryKey({ columns: [t.exerciseId, t.zone] }), index("exercise_zone_zone").on(t.zone)],
);
