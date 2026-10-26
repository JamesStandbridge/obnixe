import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import type { JournaledTable } from "./enums.ts";
import { fieldValues } from "./fields.ts";
import { exerciseNameKey } from "./names.ts";
import * as tables from "./tables/index.ts";

const localDate = z.iso.date();
const timeZone = z.string().regex(/^(UTC|[A-Z][A-Za-z_]+(\/[A-Za-z0-9_+-]+){1,2})$/);
const occurred = { localDate, timeZone };
const optionalText = z.string().trim().min(1).nullable().optional();

export const rowSchemas = {
  sport_preference: createInsertSchema(tables.sportPreference),
  exercise: createInsertSchema(tables.exercise)
    .extend({ name: z.string().trim().min(1) })
    .refine((row) => row.nameKey === exerciseNameKey(row.name), { path: ["nameKey"] }),
  exercise_zone: createInsertSchema(tables.exerciseZone),
  measurement_kind: createInsertSchema(tables.measurementKind),
  program: createInsertSchema(tables.program),
  program_version: createInsertSchema(tables.programVersion).extend({ summary: optionalText, reason: optionalText }),
  program_slot: createInsertSchema(tables.programSlot).extend({ targetValues: fieldValues }),
  program_variant: createInsertSchema(tables.programVariant),
  program_item: createInsertSchema(tables.programItem),
  rotation_skip: createInsertSchema(tables.rotationSkip).extend({ localDate }),
  session: createInsertSchema(tables.session).extend({ values: fieldValues, localDate, timeZone, title: optionalText, note: optionalText }),
  strength_entry: createInsertSchema(tables.strengthEntry).extend({ note: optionalText }),
  strength_set: createInsertSchema(tables.strengthSet),
  session_item: createInsertSchema(tables.sessionItem).extend({ values: fieldValues }),
  weigh_in: createInsertSchema(tables.weighIn).extend(occurred),
  measurement: createInsertSchema(tables.measurement).extend(occurred),
  photo: createInsertSchema(tables.photo).extend(occurred),
  check_in: createInsertSchema(tables.checkIn).extend(occurred),
  pain_report: createInsertSchema(tables.painReport).extend({ ...occurred, note: optionalText }),
  zone_tracking: createInsertSchema(tables.zoneTracking),
  gear: createInsertSchema(tables.gear).extend({ name: z.string().trim().min(1) }),
} as const satisfies Record<JournaledTable, z.ZodType>;
