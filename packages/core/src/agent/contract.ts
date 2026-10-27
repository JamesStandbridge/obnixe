import { z } from "zod";
import { efforts, equipments, exerciseCuesMaxLength, exerciseMeasures, loadModes, painLevels, painPhases, sensations, sleepBuckets, sportKeys, zoneKeys } from "@obnixe/schema";
import type { AgentCallKind, LocalDate, SportKey } from "@obnixe/schema";
import { daysBetween } from "../dates.ts";

export type AgentPermission = "body" | "photos" | "write";

export interface ToolContract {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly kind: AgentCallKind;
  readonly permissions: readonly AgentPermission[];
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

const strengthExercisesInput = z
  .array(z.object({ exercise: exerciseReference, newExercise: newExercise.optional(), note: shortText.optional(), sets: z.array(strengthSetInput).min(1).max(20) }))
  .min(1)
  .max(30);

const sessionId = z.string().min(1).describe("Session id from get_history.");

export const toolContracts = {
  list_sports: {
    name: "list_sports",
    title: "Sports",
    description:
      "List the sports Obnixe tracks with their session and item fields (key, type, unit dimension, allowed options and grades), pain zones and the catalog version. Call this before logging activities or setting slot targets.",
    kind: "read",
    permissions: [],
    input: z.object({}),
  },
  get_history: {
    name: "get_history",
    title: "Training history",
    description:
      "Return the sessions of a date range (max 366 days), newest first: id (for update_session, update_strength_session and delete_session), sport, status, start time, duration in seconds, catalog values, effort, sensation, enjoyment, notes, program slot, strength exercises with their loadMode and baseGrams and every set (loadGrams as entered, totalLoadGrams the resulting total external load in grams, reps, durationSeconds, rir), itemized entries (e.g. climbing problems) and pain reports.",
    kind: "read",
    permissions: [],
    input: z.object({ ...range, sport: z.enum(sportKeys).optional().describe("Only this sport.") }).refine(rangeRule.check, rangeRule.params),
  },
  get_exercise_progress: {
    name: "get_exercise_progress",
    title: "Exercise progress",
    description:
      "Return the history of one strength exercise with its loadMode and baseGrams: per session the sets (loadGrams as entered, totalLoadGrams the resulting total external load in grams, reps, durationSeconds, rir), best set, estimated one-rep max in grams (Epley) and volume in gram-reps, both computed from totalLoadGrams. Defaults to the whole history.",
    kind: "read",
    permissions: [],
    input: z.object({ exercise: exerciseReference, from: localDate.optional(), to: localDate.optional() }),
  },
  get_body_signals: {
    name: "get_body_signals",
    title: "Body signals",
    description:
      "Return recovery signals for a date range (max 366 days): daily check-ins (energy 1-5, sleep bucket), pain reports (zone, level none/discomfort/stop, phase, session), zone tracking periods. Weigh-ins (grams) and body measurements (millimeters) are included only when the user allowed body access; 'bodyIncluded' tells which.",
    kind: "read",
    permissions: [],
    input: z.object(range).refine(rangeRule.check, rangeRule.params),
  },
  list_photos: {
    name: "list_photos",
    title: "Progress photos",
    description: "List progress photo metadata (pose, day, pixel size). Requires the user's photo permission. Image files stay on the phone.",
    kind: "read",
    permissions: ["photos"],
    input: z.object({ from: localDate.optional(), to: localDate.optional() }),
  },
  list_programs: {
    name: "list_programs",
    title: "Programs",
    description:
      "List training programs with status (draft, active, archived), latest version number, name and sessions per week. Change the status with set_program_status.",
    kind: "read",
    permissions: [],
    input: z.object({}),
  },
  get_program: {
    name: "get_program",
    title: "Program",
    description:
      "Return a program with its latest version tree: slots (sessions of the rotation) with sport, targets and variants, each variant with its exercise prescriptions. Every slot, variant and item carries a lineageId to reuse in upsert_program. Set includeHistory to get every version with its summary, reason and author.",
    kind: "read",
    permissions: [],
    input: z.object({ programId: z.string().min(1), includeHistory: z.boolean().optional() }),
  },
  list_exercises: {
    name: "list_exercises",
    title: "Exercises",
    description:
      "List strength exercises with id, name, measure, equipment, loadMode and baseGrams (what a set's loadGrams measures, see create_exercise), load step in grams of the entered value, the body zones they load and the technique cues the user reads during workouts. Edit one with update_exercise, fold duplicates with merge_exercises.",
    kind: "read",
    permissions: [],
    input: z.object({
      query: z.string().trim().min(1).optional().describe("Filter by name, case and accent insensitive."),
      includeArchived: z.boolean().optional(),
    }),
  },
  create_exercise: {
    name: "create_exercise",
    title: "Create exercise",
    description:
      "Create a strength exercise. loadMode tells what the user enters for each set, so that logging stays natural while volume and estimated maxes use the total: total as read, per_hand for each of two dumbbells, per_side for each side plus a fixed baseGrams. Fails if an exercise with the same name already exists; edit that one with update_exercise instead. The user can undo it from the phone.",
    kind: "write",
    permissions: ["write"],
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
      "Create a program (omit programId; it starts as a draft, activate it with set_program_status) or publish a new immutable version of an existing one. Send the complete program: every slot, variant and item of the new version. Reuse lineageIds from get_program for what stays the same, omit them for new elements; anything left out is removed from the new version. Unknown exercises named in items are created. The user sees 'summary' in the app and can undo the change.",
    kind: "write",
    permissions: ["write"],
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
      "Record a completed past session of any sport except strength (use log_strength_session). Values and items are validated against the sport catalog from list_sports. Correct an existing session with update_session instead of logging it again. The user can undo it from the phone.",
    kind: "write",
    permissions: ["write"],
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
      "Record a completed past strength session with its exercises and sets, in order. Check each exercise's loadMode with list_exercises first so loadGrams is the value the user read (per dumbbell, per side, or total). Unknown exercises are created. Correct an existing session with update_strength_session instead of logging it again. The user can undo it from the phone.",
    kind: "write",
    permissions: ["write"],
    input: z.object({
      startedAt: dateTime,
      durationSeconds: z.int().min(60).max(21_600).describe("Session duration in seconds."),
      exercises: strengthExercisesInput,
      effort: z.enum(efforts).optional(),
      sensation: z.enum(sensations).optional(),
      enjoyment: z.int().min(1).max(5).optional(),
      title: shortText.max(80).optional(),
      note: shortText.optional(),
    }),
  },
  get_next_session: {
    name: "get_next_session",
    title: "Next session",
    description:
      "Answer 'what do I do today?' exactly as the phone's Today screen: the active program, the next slot of its rotation (skips and completed sessions included), the slot after it, days since this slot was last completed, and this week's count against sessionsPerWeek with whether today is a planned day. For strength slots every variant is listed (the first one is the app's default) with its exercise prescriptions; each exercise carries its last performance (all sets of the latest session with that exercise, loadGrams in grams), the app's progression suggestion for the next session (kind first, increase_load, add_reps, repeat or suspended when a loaded zone hurts) and the worst recent pain on the zones it loads. Also returns an unfinished session if one is open, today's check-in and recent pain on the loaded zones. 'program' is null when no program is active.",
    kind: "read",
    permissions: [],
    input: z.object({}),
  },
  list_agent_changes: {
    name: "list_agent_changes",
    title: "Agent changes",
    description:
      "List the changes agents made to the user's data, newest first: changeset id, time, French summary, the connection and client that made it (and whether it is this connection), the tool when known, whether the user undid it on the phone, and every row it touched (table, row id, operation). Use it to avoid logging the same thing twice. Give 'from' and 'to' for a date range (max 366 days, by the time of the change), or neither for the latest changes; 'limit' caps the list (default 20, or 100 with a range). Undoing is only possible from the phone.",
    kind: "read",
    permissions: [],
    input: z
      .object({
        from: localDate.optional().describe("First day included, YYYY-MM-DD. Requires 'to'."),
        to: localDate.optional().describe("Last day included, YYYY-MM-DD. Requires 'from'."),
        limit: z.int().min(1).max(100).optional().describe("Maximum number of changes, newest first."),
      })
      .refine((value) => (value.from === undefined) === (value.to === undefined), { message: "Give both 'from' and 'to', or neither", path: ["to"] })
      .refine((value) => value.from === undefined || value.to === undefined || rangeRule.check({ from: value.from, to: value.to }), rangeRule.params),
  },
  log_check_in: {
    name: "log_check_in",
    title: "Daily check-in",
    description:
      "Record the daily check-in: energy from 1 (drained) to 5 (in great shape) and/or last night's sleep bucket (lt6: under 6 h, h6, h7, h8: about 6, 7, 8 h, gte9: 9 h or more). There is one check-in per day: answering again updates that day's check-in, and fields left out keep their value. Defaults to today. Pain belongs in report_pain. The user can undo it from the phone.",
    kind: "write",
    permissions: ["write"],
    input: z
      .object({
        localDate: localDate.optional().describe("Day of the check-in, YYYY-MM-DD, today by default. Not in the future."),
        energy: z.int().min(1).max(5).optional(),
        sleep: z.enum(sleepBuckets).optional(),
      })
      .refine((value) => value.energy !== undefined || value.sleep !== undefined, { message: "Give 'energy', 'sleep' or both", path: ["energy"] }),
  },
  report_pain: {
    name: "report_pain",
    title: "Report pain",
    description:
      "Record pain on a body zone (zones from list_sports). Levels: none (the zone is fine), discomfort (manageable), stop (had to stop or should not load it). With 'sessionId' (from get_history) the report is attached to that session and 'phase' is required (before, during, between sets or items, end); a painful report opens follow-up of the zone if it is not followed yet, as the app does. Without 'sessionId' the report goes into that day's check-in (one level per zone and day, reporting again replaces it) and 'phase' must be omitted. Painful zones suspend load progression on exercises loading them. The user can undo it from the phone.",
    kind: "write",
    permissions: ["write"],
    input: z.object({
      zone: z.enum(zoneKeys),
      level: z.enum(painLevels),
      sessionId: z.string().min(1).optional().describe("Session the pain happened in."),
      phase: z.enum(painPhases).optional().describe("Required with sessionId, not allowed without."),
      localDate: localDate.optional().describe("Only without sessionId: day of the check-in, today by default. Not in the future."),
    }),
  },
  log_weigh_in: {
    name: "log_weigh_in",
    title: "Log a weigh-in",
    description:
      "Record body weight in grams (e.g. 78400 for 78.4 kg). There is one weigh-in per day: a second one the same day replaces it. Defaults to today. Requires both the write and the body permission. The user can undo it from the phone.",
    kind: "write",
    permissions: ["write", "body"],
    input: z.object({
      grams: z.int().min(20_000).max(400_000),
      localDate: localDate.optional().describe("Day of the weigh-in, YYYY-MM-DD, today by default. Not in the future."),
    }),
  },
  log_measurements: {
    name: "log_measurements",
    title: "Log body measurements",
    description:
      "Record body measurements (circumferences) in millimeters for one day, e.g. 'Tour de taille' 82 cm = 820. Each kind is matched by id or label, case insensitively, among the user's measurement kinds (labels appear in get_body_signals). Unknown labels are rejected unless createMissingKinds is true, which creates them (French label, e.g. 'Tour de mollet') or restores an archived kind with that label. One value per kind and day: measuring again the same day replaces it. Requires both the write and the body permission. The user can undo it from the phone.",
    kind: "write",
    permissions: ["write", "body"],
    input: z.object({
      localDate: localDate.optional().describe("Day of the measurements, YYYY-MM-DD, today by default. Not in the future."),
      measurements: z
        .array(
          z.object({
            kind: z.string().trim().min(1).max(60).describe("Measurement kind id or label."),
            millimeters: z.int().min(10).max(4000),
          }),
        )
        .min(1)
        .max(20),
      createMissingKinds: z.boolean().optional(),
    }),
  },
  update_session: {
    name: "update_session",
    title: "Correct a session",
    description:
      "Correct a completed session of any sport: start time, duration, title, note, effort, sensation, enjoyment and, for sports other than strength, the catalog values and itemized entries. Only the fields you send change; send null to clear title, note, effort, sensation or enjoyment. 'values' replaces all session values and 'items' replaces all entries, so send complete objects (start from get_history). Strength exercises and sets are corrected with update_strength_session. Sessions still open on the phone cannot be edited. The user can undo it from the phone.",
    kind: "write",
    permissions: ["write"],
    input: z.object({
      sessionId,
      startedAt: dateTime.optional(),
      durationSeconds: z.int().min(60).max(86_400).optional().describe("Active duration in seconds, pauses excluded. Kept when omitted, also when startedAt moves."),
      values: fieldValues.optional().describe("Complete session values replacing the current ones, keyed by catalog field key (see list_sports). Not for strength sessions."),
      items: z.array(fieldValues).max(200).optional().describe("Complete list of itemized entries replacing the current ones, in order, for sports with items (e.g. climbing problems)."),
      effort: z.enum(efforts).nullable().optional(),
      sensation: z.enum(sensations).nullable().optional(),
      enjoyment: z.int().min(1).max(5).nullable().optional(),
      title: shortText.max(80).nullable().optional(),
      note: shortText.nullable().optional(),
    }),
  },
  update_strength_session: {
    name: "update_strength_session",
    title: "Correct strength exercises",
    description:
      "Replace the exercise and set list of a completed strength session. Send the complete corrected list, every exercise with every set in order, same shape as log_strength_session (start from get_history); anything left out is removed. Unknown exercises are created. Exercises that stay keep their program prescription, set times and pain anchors. Time, notes and feelings are corrected with update_session. Sessions still open on the phone cannot be edited. The user can undo it from the phone.",
    kind: "write",
    permissions: ["write"],
    input: z.object({ sessionId, exercises: strengthExercisesInput }),
  },
  delete_session: {
    name: "delete_session",
    title: "Delete a session",
    description:
      "Move a session of any sport to the phone's trash, where it stays restorable for 30 days, exactly like deleting it in the app. Sessions still open on the phone cannot be deleted. The user can undo it from the phone.",
    kind: "write",
    permissions: ["write"],
    input: z.object({ sessionId }),
  },
  update_exercise: {
    name: "update_exercise",
    title: "Edit an exercise",
    description:
      "Edit a strength exercise: rename it (names are unique, case and accent insensitive), change equipment, loadMode, baseGrams, load step, body zones or technique cues, archive or unarchive it. Changing loadMode or baseGrams reinterprets every past set of the exercise, which is how a mislabeled history is fixed (e.g. sets logged per dumbbell under total). The measure can only change while no logged session or program uses the exercise. Only the fields you send change. The user can undo it from the phone.",
    kind: "write",
    permissions: ["write"],
    input: z.object({
      exercise: exerciseReference,
      name: shortText.max(80).optional().describe("New name in French."),
      measure: newExercise.shape.measure.optional(),
      equipment: z.enum(equipments).optional(),
      loadMode: loadMode.optional(),
      baseGrams: baseGrams.nullable().optional().describe("Fixed weight counted once on top of both sides, e.g. 10000 for a 10 kg EZ bar; null removes it. Only with loadMode per_side, cleared automatically when leaving per_side."),
      loadStepGrams: z.int().min(1).max(50_000).nullable().optional().describe("Smallest load increment in grams; null removes it. Not allowed for duration exercises."),
      zones: z.array(z.enum(zoneKeys)).max(6).optional().describe("Complete list of body zones this exercise loads, replacing the current ones; [] removes them all."),
      archived: z.boolean().optional().describe("true hides the exercise from pickers while keeping its history, false brings it back."),
      cues: z
        .string()
        .max(exerciseCuesMaxLength)
        .nullable()
        .optional()
        .describe("Technique cues in French shown to the user during workouts (placement, range of motion, breathing), one short line each, replacing the current ones; null or an empty string removes them."),
    }),
  },
  merge_exercises: {
    name: "merge_exercises",
    title: "Merge exercises",
    description:
      "Fold a duplicate strength exercise into a target with the same measure: logged sessions move to the target, the duplicate's body zones are added to the target, and the duplicate is archived and redirected to the target, so its name and id keep resolving to the target. Published program versions are immutable and keep the duplicate in their items; workouts started from them use the target, and the next upsert_program version uses the target. The user can undo it from the phone.",
    kind: "write",
    permissions: ["write"],
    input: z.object({
      duplicate: exerciseReference.describe("Exercise to fold, by id or exact name."),
      target: exerciseReference.describe("Exercise that remains, by id or exact name."),
    }),
  },
  set_program_status: {
    name: "set_program_status",
    title: "Activate or archive a program",
    description:
      "Activate a draft or archived program, or archive a program. Only one program is active at a time: activating archives the current active program. Programs never go back to draft. The user can undo it from the phone.",
    kind: "write",
    permissions: ["write"],
    input: z.object({ programId: z.string().min(1), status: z.enum(["active", "archived"]) }),
  },
} as const satisfies Record<string, ToolContract>;

export type ToolName = keyof typeof toolContracts;
export type ToolInput<N extends ToolName> = z.infer<(typeof toolContracts)[N]["input"]>;

export const toolNames = Object.keys(toolContracts) as [ToolName, ...ToolName[]];

/** Writes that overwrite or remove existing data rather than add to it; MCP clients may ask the user before running them. */
export const destructiveTools: ReadonlySet<ToolName> = new Set<ToolName>(["update_session", "update_strength_session", "delete_session", "update_exercise", "merge_exercises"]);

export function isToolName(name: string): name is ToolName {
  return Object.hasOwn(toolContracts, name);
}
