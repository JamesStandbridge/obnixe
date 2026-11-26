import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { sports } from "./catalog/sports.ts";
import type { JournaledTable } from "./enums.ts";
import { fieldValues } from "./fields.ts";
import { exerciseNameKey } from "./names.ts";
import { boundingBoxE7Schema, recordingSettingsSchema, recordingWeatherSchema } from "./recording.ts";
import type { RecordingSettings } from "./recording.ts";
import * as tables from "./tables/index.ts";

const localDate = z.iso.date();
const timeZone = z.string().regex(/^(UTC|[A-Z][A-Za-z_]+(\/[A-Za-z0-9_+-]+){1,2})$/);
const occurred = { localDate, timeZone };
const optionalText = z.string().trim().min(1).nullable().optional();
const label = z.string().trim().min(1);
const sha256 = z.string().regex(/^[0-9a-f]{64}$/);

function settingsFitProfile(row: { readonly sport: keyof typeof sports; readonly recordingSettings?: RecordingSettings | null | undefined }): boolean {
  const settings = row.recordingSettings ?? null;
  if (settings === null) return true;
  const profile = sports[row.sport].recording;
  if (profile === null) return false;
  const readout = settings.readout;
  const range = settings.alerts.paceRange;
  return (readout === null || [readout.main, ...readout.secondary].every((metric) => profile.metrics.includes(metric))) && (range === null || range.kind === profile.primary);
}

export const exerciseCuesMaxLength = 2000;

export const rowSchemas = {
  sport_preference: createInsertSchema(tables.sportPreference)
    .extend({ recordingSettings: recordingSettingsSchema.nullable().optional() })
    .refine(settingsFitProfile, { path: ["recordingSettings"], message: "Recording settings need a recordable sport, metrics of its profile and a pace or speed span after its primary measure" }),
  exercise: createInsertSchema(tables.exercise)
    .extend({ name: z.string().trim().min(1), cues: z.string().trim().min(1).max(exerciseCuesMaxLength).nullable().optional() })
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
  strength_entry: createInsertSchema(tables.strengthEntry).extend({ note: optionalText, plannedSets: z.int().positive().nullable().optional() }),
  strength_set: createInsertSchema(tables.strengthSet),
  session_item: createInsertSchema(tables.sessionItem).extend({ values: fieldValues }),
  weigh_in: createInsertSchema(tables.weighIn).extend(occurred),
  measurement: createInsertSchema(tables.measurement).extend(occurred),
  photo: createInsertSchema(tables.photo).extend(occurred),
  check_in: createInsertSchema(tables.checkIn).extend(occurred),
  pain_report: createInsertSchema(tables.painReport).extend({ ...occurred, note: optionalText }),
  zone_tracking: createInsertSchema(tables.zoneTracking),
  gear: createInsertSchema(tables.gear).extend({ name: z.string().trim().min(1) }),
  recording: createInsertSchema(tables.recording).extend({
    device: label,
    externalId: label.nullable().optional(),
    heartRateDevice: label.nullable().optional(),
    weather: recordingWeatherSchema.nullable().optional(),
    bbox: boundingBoxE7Schema.nullable().optional(),
    trackSha256: sha256.nullable().optional(),
  }),
  route: createInsertSchema(tables.route)
    .extend({ name: label, bbox: boundingBoxE7Schema, trackSha256: sha256 })
    .refine((row) => sports[row.sport].recording !== null, { path: ["sport"], message: "A route is followed by a sport with a recording profile" }),
  lap: createInsertSchema(tables.lap),
  privacy_zone: createInsertSchema(tables.privacyZone).extend({ label }),
  segment: createInsertSchema(tables.segment)
    .extend({ name: label, bbox: boundingBoxE7Schema })
    .refine((row) => row.south === row.bbox.south && row.north === row.bbox.north, { path: ["bbox"] }),
} as const satisfies Record<JournaledTable, z.ZodType>;
