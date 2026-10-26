import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { id, localDate, ref, sport, timestamp, trashable } from "../columns.ts";
import { efforts, reviewStatuses, sensations, sessionStatuses, strengthEntryStatuses } from "../enums.ts";
import type { FieldValues } from "../fields.ts";
import { exercise } from "./exercises.ts";
import { programItem, programSlot, programVariant } from "./programs.ts";
import { gear } from "./sports.ts";

export const session = sqliteTable(
  "session",
  {
    id: id(),
    sport: sport("sport").notNull(),
    slotId: ref("slot_id").references(() => programSlot.id),
    variantId: ref("variant_id").references(() => programVariant.id),
    countsInRotation: integer("counts_in_rotation", { mode: "boolean" }).notNull(),
    gearId: ref("gear_id").references(() => gear.id),
    title: text("title"),
    status: text("status", { enum: sessionStatuses }).notNull(),
    startedAt: timestamp("started_at").notNull(),
    endedAt: timestamp("ended_at"),
    pausedSeconds: integer("paused_seconds").notNull(),
    localDate: localDate("local_date").notNull(),
    timeZone: text("time_zone").notNull(),
    values: text("values", { mode: "json" }).$type<FieldValues>().notNull(),
    effort: text("effort", { enum: efforts }),
    sensation: text("sensation", { enum: sensations }),
    enjoyment: integer("enjoyment"),
    note: text("note"),
    review: text("review", { enum: reviewStatuses }).notNull(),
    ...trashable(),
  },
  (t) => [
    index("session_date").on(t.localDate),
    index("session_sport").on(t.sport, t.startedAt),
    index("session_slot").on(t.slotId),
    uniqueIndex("session_single_open").on(sql`1`).where(sql`${t.status} <> 'completed' AND ${t.deletedAt} IS NULL`),
    check("session_end", sql`(${t.status} = 'in_progress') = (${t.endedAt} IS NULL) AND (${t.endedAt} IS NULL OR ${t.endedAt} >= ${t.startedAt})`),
    check("session_variant", sql`${t.variantId} IS NULL OR ${t.slotId} IS NOT NULL`),
    check("session_rotation", sql`NOT ${t.countsInRotation} OR ${t.slotId} IS NOT NULL`),
    check("session_enjoyment", sql`${t.enjoyment} IS NULL OR ${t.enjoyment} BETWEEN 1 AND 5`),
    check("session_paused", sql`${t.pausedSeconds} >= 0`),
  ],
);

export const strengthEntry = sqliteTable(
  "strength_entry",
  {
    id: id(),
    sessionId: ref("session_id").notNull().references(() => session.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    exerciseId: ref("exercise_id").notNull().references(() => exercise.id),
    programItemId: ref("program_item_id").references(() => programItem.id),
    status: text("status", { enum: strengthEntryStatuses }).notNull(),
    note: text("note"),
  },
  (t) => [uniqueIndex("strength_entry_position").on(t.sessionId, t.position), index("strength_entry_exercise").on(t.exerciseId)],
);

export const strengthSet = sqliteTable(
  "strength_set",
  {
    id: id(),
    entryId: ref("entry_id").notNull().references(() => strengthEntry.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    loadGrams: integer("load_grams"),
    reps: integer("reps"),
    durationSeconds: integer("duration_seconds"),
    rir: integer("rir"),
    restBeforeSeconds: integer("rest_before_seconds"),
    interrupted: integer("interrupted", { mode: "boolean" }).notNull(),
    completedAt: timestamp("completed_at").notNull(),
  },
  (t) => [
    uniqueIndex("strength_set_position").on(t.entryId, t.position),
    check("strength_set_rir", sql`${t.rir} IS NULL OR ${t.rir} BETWEEN 0 AND 10`),
    check("strength_set_load", sql`${t.loadGrams} IS NULL OR ${t.loadGrams} >= 0`),
    check("strength_set_effort", sql`${t.interrupted} OR ${t.reps} > 0 OR ${t.durationSeconds} > 0`),
    check("strength_set_measure", sql`${t.reps} IS NULL OR ${t.durationSeconds} IS NULL`),
  ],
);

export const sessionItem = sqliteTable(
  "session_item",
  {
    id: id(),
    sessionId: ref("session_id").notNull().references(() => session.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    values: text("values", { mode: "json" }).$type<FieldValues>().notNull(),
    recordedAt: timestamp("recorded_at").notNull(),
  },
  (t) => [uniqueIndex("session_item_position").on(t.sessionId, t.position)],
);
