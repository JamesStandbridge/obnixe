import { sports, targetValuesSchema } from "@obnixe/schema";
import type { Exercise, Id } from "@obnixe/schema";
import type { DraftItem, DraftSlot, ProgramDraft } from "./draft.ts";

export type ExerciseRef = Pick<Exercise, "id" | "name" | "measure" | "archivedAt" | "mergedIntoId">;

export const programLimits = {
  sessionsPerWeek: { min: 1, max: 14 },
  sets: { min: 1, max: 20 },
  reps: { min: 1, max: 100 },
  durationSeconds: { min: 1, max: 3600 },
  rir: { min: 0, max: 5 },
  restSeconds: { min: 0, max: 1800 },
  targetDurationSeconds: { min: 60, max: 24 * 3600 },
} as const;

export type ItemProblem = "exercise_missing" | "exercise_unavailable" | "target_mismatch" | "sets_invalid" | "range_invalid" | "rir_invalid" | "rest_invalid";

export type DraftIssue =
  | { readonly kind: "program_name_missing" }
  | { readonly kind: "sessions_per_week_invalid" }
  | { readonly kind: "no_slots" }
  | { readonly kind: "duplicate_lineage"; readonly lineageId: Id }
  | { readonly kind: "slot_name_missing"; readonly slot: Id }
  | { readonly kind: "variants_missing"; readonly slot: Id }
  | { readonly kind: "variants_not_allowed"; readonly slot: Id }
  | { readonly kind: "target_duration_invalid"; readonly slot: Id }
  | { readonly kind: "target_values_invalid"; readonly slot: Id; readonly fields: readonly string[] }
  | { readonly kind: "variant_name_missing"; readonly slot: Id; readonly variant: Id }
  | { readonly kind: "variant_name_duplicate"; readonly slot: Id; readonly variant: Id }
  | { readonly kind: "variant_empty"; readonly slot: Id; readonly variant: Id }
  | { readonly kind: "item_invalid"; readonly slot: Id; readonly variant: Id; readonly item: Id; readonly problem: ItemProblem };

export type DraftValidation = { readonly valid: true } | { readonly valid: false; readonly issues: readonly [DraftIssue, ...DraftIssue[]] };

const between = (value: number, range: { readonly min: number; readonly max: number }): boolean =>
  Number.isInteger(value) && value >= range.min && value <= range.max;

export function validateDraft(draft: ProgramDraft, exercises: ReadonlyMap<Id, ExerciseRef>): DraftValidation {
  const issues: DraftIssue[] = [];
  if (draft.name.trim() === "") issues.push({ kind: "program_name_missing" });
  if (!between(draft.sessionsPerWeek, programLimits.sessionsPerWeek)) issues.push({ kind: "sessions_per_week_invalid" });
  if (draft.slots.length === 0) issues.push({ kind: "no_slots" });
  const lineages = new Set<Id>();
  const claim = (lineageId: Id): void => {
    if (lineages.has(lineageId)) issues.push({ kind: "duplicate_lineage", lineageId });
    lineages.add(lineageId);
  };
  for (const slot of draft.slots) {
    claim(slot.lineageId);
    issues.push(...slotIssues(slot));
    const names = new Set<string>();
    for (const variant of slot.variants) {
      claim(variant.lineageId);
      const name = variant.name.trim().toLowerCase();
      if (name === "") issues.push({ kind: "variant_name_missing", slot: slot.lineageId, variant: variant.lineageId });
      else if (names.has(name)) issues.push({ kind: "variant_name_duplicate", slot: slot.lineageId, variant: variant.lineageId });
      names.add(name);
      if (variant.items.length === 0) issues.push({ kind: "variant_empty", slot: slot.lineageId, variant: variant.lineageId });
      for (const item of variant.items) {
        claim(item.lineageId);
        const problem = itemProblem(item, exercises.get(item.exerciseId));
        if (problem !== null) issues.push({ kind: "item_invalid", slot: slot.lineageId, variant: variant.lineageId, item: item.lineageId, problem });
      }
    }
  }
  const [first, ...rest] = issues;
  return first === undefined ? { valid: true } : { valid: false, issues: [first, ...rest] };
}

function slotIssues(slot: DraftSlot): DraftIssue[] {
  const issues: DraftIssue[] = [];
  if (slot.name.trim() === "") issues.push({ kind: "slot_name_missing", slot: slot.lineageId });
  const sport = sports[slot.sport];
  if (sport.archetype === "strength") {
    if (slot.variants.length === 0) issues.push({ kind: "variants_missing", slot: slot.lineageId });
  } else if (slot.variants.length > 0) {
    issues.push({ kind: "variants_not_allowed", slot: slot.lineageId });
  }
  if (slot.targetDurationSeconds !== null && !between(slot.targetDurationSeconds, programLimits.targetDurationSeconds)) {
    issues.push({ kind: "target_duration_invalid", slot: slot.lineageId });
  }
  const parsed = targetValuesSchema(sport).safeParse(slot.targetValues);
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map((issue) => String(issue.path[0] ?? "")))];
    issues.push({ kind: "target_values_invalid", slot: slot.lineageId, fields });
  }
  return issues;
}

function itemProblem(item: DraftItem, exercise: ExerciseRef | undefined): ItemProblem | null {
  if (exercise === undefined) return "exercise_missing";
  if (exercise.archivedAt !== null || exercise.mergedIntoId !== null) return "exercise_unavailable";
  if ((exercise.measure === "duration") !== (item.target.kind === "duration")) return "target_mismatch";
  if (!between(item.sets, programLimits.sets)) return "sets_invalid";
  const target = item.target;
  switch (target.kind) {
    case "reps":
      if (!between(target.min, programLimits.reps) || !between(target.max, programLimits.reps) || target.max < target.min) return "range_invalid";
      break;
    case "duration":
      if (!between(target.minSeconds, programLimits.durationSeconds) || !between(target.maxSeconds, programLimits.durationSeconds) || target.maxSeconds < target.minSeconds) {
        return "range_invalid";
      }
      break;
    default: {
      const unreachable: never = target;
      throw new Error(`Unhandled item target ${JSON.stringify(unreachable)}`);
    }
  }
  if (item.targetRir !== null && !between(item.targetRir, programLimits.rir)) return "rir_invalid";
  for (const rest of [item.restSeconds, item.restAfterSeconds]) {
    if (rest !== null && !between(rest, programLimits.restSeconds)) return "rest_invalid";
  }
  return null;
}
