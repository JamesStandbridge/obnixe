import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import type { AnySQLiteColumn } from "drizzle-orm/sqlite-core";
import { id, localDate, ref, sport, timestamp, tracked } from "../columns.ts";
import { efforts, programStatuses } from "../enums.ts";
import type { FieldValues } from "../fields.ts";
import { exercise } from "./exercises.ts";
import { changeset } from "./journal.ts";

export const program = sqliteTable(
  "program",
  {
    id: id(),
    status: text("status", { enum: programStatuses }).notNull(),
    ...tracked(),
  },
  (t) => [uniqueIndex("program_single_active").on(t.status).where(sql`${t.status} = 'active'`)],
);

export const programVersion = sqliteTable(
  "program_version",
  {
    id: id(),
    programId: ref("program_id").notNull().references(() => program.id),
    number: integer("number").notNull(),
    name: text("name").notNull(),
    sessionsPerWeek: integer("sessions_per_week").notNull(),
    copiedFromId: ref("copied_from_id").references((): AnySQLiteColumn => programVersion.id),
    summary: text("summary"),
    reason: text("reason"),
    changesetId: ref("changeset_id").notNull().references(() => changeset.id),
    createdAt: timestamp("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("program_version_number").on(t.programId, t.number),
    check("program_version_number_positive", sql`${t.number} >= 1`),
    check("program_version_frequency", sql`${t.sessionsPerWeek} BETWEEN 1 AND 14`),
  ],
);

export const programSlot = sqliteTable(
  "program_slot",
  {
    id: id(),
    versionId: ref("version_id").notNull().references(() => programVersion.id, { onDelete: "cascade" }),
    lineageId: ref("lineage_id").notNull(),
    position: integer("position").notNull(),
    sport: sport("sport").notNull(),
    name: text("name").notNull(),
    targetDurationSeconds: integer("target_duration_seconds"),
    targetEffort: text("target_effort", { enum: efforts }),
    targetValues: text("target_values", { mode: "json" }).$type<FieldValues>().notNull(),
  },
  (t) => [uniqueIndex("program_slot_position").on(t.versionId, t.position), uniqueIndex("program_slot_lineage").on(t.versionId, t.lineageId)],
);

export const programVariant = sqliteTable(
  "program_variant",
  {
    id: id(),
    slotId: ref("slot_id").notNull().references(() => programSlot.id, { onDelete: "cascade" }),
    lineageId: ref("lineage_id").notNull(),
    position: integer("position").notNull(),
    name: text("name").notNull(),
  },
  (t) => [uniqueIndex("program_variant_position").on(t.slotId, t.position), uniqueIndex("program_variant_lineage").on(t.slotId, t.lineageId)],
);

export const programItem = sqliteTable(
  "program_item",
  {
    id: id(),
    variantId: ref("variant_id").notNull().references(() => programVariant.id, { onDelete: "cascade" }),
    lineageId: ref("lineage_id").notNull(),
    position: integer("position").notNull(),
    exerciseId: ref("exercise_id").notNull().references(() => exercise.id),
    sets: integer("sets").notNull(),
    repsMin: integer("reps_min"),
    repsMax: integer("reps_max"),
    durationMinSeconds: integer("duration_min_seconds"),
    durationMaxSeconds: integer("duration_max_seconds"),
    targetRir: integer("target_rir"),
    restSeconds: integer("rest_seconds"),
    restAfterSeconds: integer("rest_after_seconds"),
  },
  (t) => [
    uniqueIndex("program_item_position").on(t.variantId, t.position),
    uniqueIndex("program_item_lineage").on(t.variantId, t.lineageId),
    index("program_item_exercise").on(t.exerciseId),
    check("program_item_sets", sql`${t.sets} >= 1`),
    check(
      "program_item_target",
      sql`(${t.repsMin} IS NOT NULL AND ${t.repsMax} >= ${t.repsMin} AND ${t.durationMinSeconds} IS NULL AND ${t.durationMaxSeconds} IS NULL) OR (${t.repsMin} IS NULL AND ${t.repsMax} IS NULL AND ${t.durationMinSeconds} IS NOT NULL AND ${t.durationMaxSeconds} >= ${t.durationMinSeconds})`,
    ),
    check("program_item_rir", sql`${t.targetRir} IS NULL OR ${t.targetRir} BETWEEN 0 AND 5`),
  ],
);

export const rotationSkip = sqliteTable(
  "rotation_skip",
  {
    id: id(),
    programId: ref("program_id").notNull().references(() => program.id),
    slotLineageId: ref("slot_lineage_id").notNull(),
    skippedAt: timestamp("skipped_at").notNull(),
    localDate: localDate("local_date").notNull(),
  },
  (t) => [index("rotation_skip_program").on(t.programId, t.skippedAt)],
);
