import { z } from "zod";
import { efforts, equipments, exerciseMeasures, loadModes, sensations, sportKeys, zoneKeys } from "@obnixe/schema";
import type { AgentCallKind, LocalDate, SportKey } from "@obnixe/schema";
import { daysBetween } from "../dates.ts";

export type AgentPermission = "body" | "photos" | "write";

export interface ToolContract {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly kind: AgentCallKind;
  readonly permission: AgentPermission | null;
  readonly input: z.ZodObject;
}

const maxRangeDays = 366;

const localDate = z.iso.date().describe("Local calendar date, YYYY-MM-DD.");
const dateTime = z.iso
  .datetime({ offset: true, local: false })
  .describe("Local start time with its UTC offset, ISO 8601, e.g. 2026-10-10T09:30:00+02:00. The date part becomes the session day.");
const lineageId = z.string().min(1);
const shortText = z.string().trim().min(1).max(500);
const nonStrengthSports = sportKeys.filter((key): key is Exclude<SportKey, "strength"> => key !== "strength") as [
  Exclude<SportKey, "strength">,
  ...Exclude<SportKey, "strength">[],
];
const fieldValue = z.union([z.int(), z.string(), z.array(z.string()), z.boolean()]);
const fieldValues = z
  .record(z.string(), fieldValue)
  .describe(
    "Values keyed by catalog field key (see list_sports). Quantities are integers in base units: mass grams, length millimeters, distance meters, duration seconds, heart_rate beats per minute, power watts, count units. Grades are '<scale>:<grade>' such as 'fontainebleau:6B+'. Choices use option keys.",
  );

const range = {
  from: localDate.describe("First day included, YYYY-MM-DD."),
  to: localDate.describe("Last day included, YYYY-MM-DD."),
};

const rangeRule = {
  check: (value: { readonly from: string; readonly to: string }): boolean => {
    const days = daysBetween(value.from as LocalDate, value.to as LocalDate);
    return days >= 0 && days < maxRangeDays;
  },
  params: { message: `'from' must not be after 'to' and the range must not exceed ${maxRangeDays} days`, path: ["to"] },
};

const exerciseReference = z.string().trim().min(1).describe("Exercise id, or exact exercise name (matched case and accent insensitively).");
const loadMode = z
  .enum(loadModes)
  .describe(
    "What a set's loadGrams measures. total: the whole load as read, e.g. a loaded barbell, a machine or cable stack, a single dumbbell or kettlebell held alone. per_hand: one of two identical dumbbells or kettlebells, e.g. lateral raises with 4 kg in each hand are logged as loadGrams 4000. per_side: the load on one side, e.g. plates per side of a bar or each of two cable stacks; any fixed bar or sled goes in baseGrams. Defaults to per_hand for dumbbell and kettlebell, total otherwise. Duration exercises are always total.",
  );
const baseGrams = z
  .int()
  .min(1)
  .max(500_000)
  .describe("Fixed weight counted once on top of both sides, e.g. 10000 for a 10 kg EZ bar loaded with plates per side. Only with loadMode per_side.");
const newExercise = z
  .object({
    measure: z.enum(exerciseMeasures).describe("load_reps: external load and reps; bodyweight_reps: reps with optional added load; duration: holds in seconds."),
    equipment: z.enum(equipments),
    loadMode: loadMode.optional(),
    baseGrams: baseGrams.optional(),
  })
  .describe("Only used when 'exercise' matches no existing exercise: the exercise is then created with these properties. Without it, unknown exercises are created as load_reps / other / total.");

const programItemInput = z
  .object({
    lineageId: lineageId.optional().describe("Keep the lineageId returned by get_program to mark this item as the same prescription as before. Omit for a new item."),
    exercise: exerciseReference,
    newExercise: newExercise.optional(),
    sets: z.int().min(1).max(20),
    repsMin: z.int().min(1).max(100).optional(),
    repsMax: z.int().min(1).max(100).optional(),
    durationMinSeconds: z.int().min(1).max(3600).optional(),
    durationMaxSeconds: z.int().min(1).max(3600).optional(),
    targetRir: z.int().min(0).max(5).optional().describe("Target reps in reserve."),
    restSeconds: z.int().min(0).max(1800).optional().describe("Rest between sets, seconds."),
    restAfterSeconds: z.int().min(0).max(1800).optional().describe("Rest after the last set before the next exercise, seconds."),
  })
  .describe("Give either repsMin and repsMax (repsMax >= repsMin) or durationMinSeconds and durationMaxSeconds, never both.");

const programVariantInput = z.object({
  lineageId: lineageId.optional().describe("Keep the lineageId returned by get_program for an existing variant. Omit for a new variant."),
  name: shortText.max(60).describe("Variant name in French, e.g. 'Salle' or 'Maison'."),
  items: z.array(programItemInput).min(1).max(30),
});

const programSlotInput = z.object({
  lineageId: lineageId.optional().describe("Keep the lineageId returned by get_program so the rotation and history continue. Omit for a new session slot."),
  name: shortText.max(60).describe("Session name in French, e.g. 'Séance A' or 'Footing'."),
  sport: z.enum(sportKeys),
  targetDurationSeconds: z.int().min(60).max(86_400).optional(),
  targetEffort: z.enum(efforts).optional(),
  targetValues: fieldValues.optional().describe("Optional session targets keyed by catalog session field key, same units as list_sports."),
  variants: z
    .array(programVariantInput)
    .max(4)
    .describe("Strength slots need at least one variant with exercises; other sports take an empty list."),
});

const strengthSetInput = z
  .object({
    loadGrams: z
      .int()
      .min(0)
      .max(1_000_000)
      .optional()
      .describe(
        "Load in grams exactly as the user reads it, interpreted by the exercise's loadMode (see list_exercises, or newExercise for a new one); never multiply it yourself. total: whole load (62500 for a 62.5 kg barbell). per_hand: one implement ('4 kg each dumbbell' is 4000). per_side: one side without the bar ('10 kg plates each side' is 10000). Required for load_reps, optional added load for bodyweight_reps.",
      ),
    reps: z.int().min(1).max(200).optional(),
    durationSeconds: z.int().min(1).max(3600).optional(),
    rir: z.int().min(0).max(10).optional().describe("Reps in reserve."),
    restBeforeSeconds: z.int().min(0).max(1800).optional(),
  })
  .describe("Reps for load_reps and bodyweight_reps exercises, durationSeconds for duration exercises.");

export const toolContracts = {
  list_sports: {
    name: "list_sports",
    title: "Sports",
    description:
      "List the sports Obnixe tracks with their session and item fields (key, type, unit dimension, allowed options and grades), pain zones and the catalog version. Call this before logging activities or setting slot targets.",
    kind: "read",
    permission: null,
    input: z.object({}),
  },
  get_history: {
    name: "get_history",
    title: "Training history",
    description:
      "Return the sessions of a date range (max 366 days), newest first: sport, status, start time, duration in seconds, catalog values, effort, sensation, enjoyment, notes, program slot, strength exercises with their loadMode and baseGrams and every set (loadGrams as entered, totalLoadGrams the resulting total external load in grams, reps, durationSeconds, rir), itemized entries (e.g. climbing problems) and pain reports.",
    kind: "read",
    permission: null,
    input: z.object({ ...range, sport: z.enum(sportKeys).optional().describe("Only this sport.") }).refine(rangeRule.check, rangeRule.params),
  },
  get_exercise_progress: {
    name: "get_exercise_progress",
    title: "Exercise progress",
    description:
      "Return the history of one strength exercise with its loadMode and baseGrams: per session the sets (loadGrams as entered, totalLoadGrams the resulting total external load in grams, reps, durationSeconds, rir), best set, estimated one-rep max in grams (Epley) and volume in gram-reps, both computed from totalLoadGrams. Defaults to the whole history.",
    kind: "read",
    permission: null,
    input: z.object({ exercise: exerciseReference, from: localDate.optional(), to: localDate.optional() }),
  },
  get_body_signals: {
    name: "get_body_signals",
    title: "Body signals",
    description:
      "Return recovery signals for a date range (max 366 days): daily check-ins (energy 1-5, sleep bucket), pain reports (zone, level none/discomfort/stop, phase, session), zone tracking periods. Weigh-ins (grams) and body measurements (millimeters) are included only when the user allowed body access; 'bodyIncluded' tells which.",
    kind: "read",
    permission: null,
    input: z.object(range).refine(rangeRule.check, rangeRule.params),
  },
  list_photos: {
    name: "list_photos",
    title: "Progress photos",
    description: "List progress photo metadata (pose, day, pixel size). Requires the user's photo permission. Image files stay on the phone.",
    kind: "read",
    permission: "photos",
    input: z.object({ from: localDate.optional(), to: localDate.optional() }),
  },
  list_programs: {
    name: "list_programs",
    title: "Programs",
    description: "List training programs with status (draft, active, archived), latest version number, name and sessions per week.",
    kind: "read",
    permission: null,
    input: z.object({}),
  },
  get_program: {
    name: "get_program",
    title: "Program",
    description:
      "Return a program with its latest version tree: slots (sessions of the rotation) with sport, targets and variants, each variant with its exercise prescriptions. Every slot, variant and item carries a lineageId to reuse in upsert_program. Set includeHistory to get every version with its summary, reason and author.",
    kind: "read",
    permission: null,
    input: z.object({ programId: z.string().min(1), includeHistory: z.boolean().optional() }),
  },
  list_exercises: {
    name: "list_exercises",
    title: "Exercises",
    description:
      "List strength exercises with id, name, measure, equipment, loadMode and baseGrams (what a set's loadGrams measures, see create_exercise), load step in grams of the entered value and the body zones they load.",
    kind: "read",
    permission: null,
    input: z.object({
      query: z.string().trim().min(1).optional().describe("Filter by name, case and accent insensitive."),
      includeArchived: z.boolean().optional(),
    }),
  },
  create_exercise: {
    name: "create_exercise",
    title: "Create exercise",
    description:
      "Create a strength exercise. loadMode tells what the user enters for each set, so that logging stays natural while volume and estimated maxes use the total: total as read, per_hand for each of two dumbbells, per_side for each side plus a fixed baseGrams. Fails if an exercise with the same name already exists. The user can undo it from the phone.",
    kind: "write",
    permission: "write",
    input: z.object({
      name: shortText.max(80).describe("Exercise name in French, e.g. 'Rowing haltère'."),
      measure: newExercise.shape.measure,
      equipment: z.enum(equipments),
      loadMode: loadMode.optional(),
      baseGrams: baseGrams.optional(),
      loadStepGrams: z.int().min(1).max(50_000).optional().describe("Smallest increment of the entered load in grams, e.g. 2500, or 1000 per dumbbell for per_hand. Not allowed for duration exercises."),
      zones: z.array(z.enum(zoneKeys)).max(6).optional().describe("Body zones this exercise loads, used for pain follow-up."),
    }),
  },
  upsert_program: {
    name: "upsert_program",
    title: "Create or revise a program",
    description:
      "Create a program (omit programId; it starts as a draft) or publish a new immutable version of an existing one. Send the complete program: every slot, variant and item of the new version. Reuse lineageIds from get_program for what stays the same, omit them for new elements; anything left out is removed from the new version. Unknown exercises named in items are created. The user sees 'summary' in the app and can undo the change.",
    kind: "write",
    permission: "write",
    input: z.object({
      programId: z.string().min(1).optional(),
      name: shortText.max(60).describe("Program name in French."),
      sessionsPerWeek: z.int().min(1).max(14),
      summary: shortText.max(90).describe("What changed, terse French sentence starting with a capital, e.g. 'Rowing haltère au lieu du tirage menton'."),
      reason: shortText.optional().describe("Why, in French, optional."),
      slots: z.array(programSlotInput).min(1).max(14).describe("Ordered rotation of sessions."),
    }),
  },
  log_activity: {
    name: "log_activity",
    title: "Log an activity",
    description:
      "Record a completed past session of any sport except strength (use log_strength_session). Values and items are validated against the sport catalog from list_sports. The user can undo it from the phone.",
    kind: "write",
    permission: "write",
    input: z.object({
      sport: z.enum(nonStrengthSports),
      startedAt: dateTime,
      durationSeconds: z.int().min(60).max(86_400).describe("Moving duration in seconds."),
      values: fieldValues.optional(),
      items: z.array(fieldValues).max(200).optional().describe("Itemized entries for sports with items (e.g. one entry per climbing problem), keyed by catalog item field key."),
      effort: z.enum(efforts).optional(),
      sensation: z.enum(sensations).optional(),
      enjoyment: z.int().min(1).max(5).optional(),
      title: shortText.max(80).optional(),
      note: shortText.optional(),
    }),
  },
  log_strength_session: {
    name: "log_strength_session",
    title: "Log a strength session",
    description:
      "Record a completed past strength session with its exercises and sets, in order. Check each exercise's loadMode with list_exercises first so loadGrams is the value the user read (per dumbbell, per side, or total). Unknown exercises are created. The user can undo it from the phone.",
    kind: "write",
    permission: "write",
    input: z.object({
      startedAt: dateTime,
      durationSeconds: z.int().min(60).max(21_600).describe("Session duration in seconds."),
      exercises: z
        .array(z.object({ exercise: exerciseReference, newExercise: newExercise.optional(), note: shortText.optional(), sets: z.array(strengthSetInput).min(1).max(20) }))
        .min(1)
        .max(30),
      effort: z.enum(efforts).optional(),
      sensation: z.enum(sensations).optional(),
      enjoyment: z.int().min(1).max(5).optional(),
      title: shortText.max(80).optional(),
      note: shortText.optional(),
    }),
  },
} as const satisfies Record<string, ToolContract>;

export type ToolName = keyof typeof toolContracts;
export type ToolInput<N extends ToolName> = z.infer<(typeof toolContracts)[N]["input"]>;

export const toolNames = Object.keys(toolContracts) as [ToolName, ...ToolName[]];

export function isToolName(name: string): name is ToolName {
  return Object.hasOwn(toolContracts, name);
}
