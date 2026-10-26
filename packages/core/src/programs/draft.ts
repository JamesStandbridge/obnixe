import type { Effort, FieldValues, Id, ProgramItem, ProgramSlot, ProgramVariant, ProgramVersion, SportKey } from "@obnixe/schema";

export type ItemTarget =
  | { readonly kind: "reps"; readonly min: number; readonly max: number }
  | { readonly kind: "duration"; readonly minSeconds: number; readonly maxSeconds: number };

export interface DraftItem {
  readonly lineageId: Id;
  readonly exerciseId: Id;
  readonly sets: number;
  readonly target: ItemTarget;
  readonly targetRir: number | null;
  readonly restSeconds: number | null;
  readonly restAfterSeconds: number | null;
}

export interface DraftVariant {
  readonly lineageId: Id;
  readonly name: string;
  readonly items: readonly DraftItem[];
}

export interface DraftSlot {
  readonly lineageId: Id;
  readonly sport: SportKey;
  readonly name: string;
  readonly targetDurationSeconds: number | null;
  readonly targetEffort: Effort | null;
  readonly targetValues: FieldValues;
  readonly variants: readonly DraftVariant[];
}

export interface ProgramDraft {
  readonly name: string;
  readonly sessionsPerWeek: number;
  readonly slots: readonly DraftSlot[];
}

export interface VariantTree {
  readonly variant: ProgramVariant;
  readonly items: readonly ProgramItem[];
}

export interface SlotTree {
  readonly slot: ProgramSlot;
  readonly variants: readonly VariantTree[];
}

export interface VersionTree {
  readonly version: ProgramVersion;
  readonly slots: readonly SlotTree[];
}

export class InvalidItemTargetError extends Error {
  constructor(readonly itemId: Id) {
    super(`Program item ${itemId} has neither a reps nor a duration range`);
  }
}

export function emptyDraft(): ProgramDraft {
  return { name: "", sessionsPerWeek: 3, slots: [] };
}

export function itemTarget(item: ProgramItem): ItemTarget {
  if (item.repsMin !== null && item.repsMax !== null) return { kind: "reps", min: item.repsMin, max: item.repsMax };
  if (item.durationMinSeconds !== null && item.durationMaxSeconds !== null) {
    return { kind: "duration", minSeconds: item.durationMinSeconds, maxSeconds: item.durationMaxSeconds };
  }
  throw new InvalidItemTargetError(item.id);
}

export function draftFromTree(tree: VersionTree): ProgramDraft {
  return {
    name: tree.version.name,
    sessionsPerWeek: tree.version.sessionsPerWeek,
    slots: tree.slots.map(
      ({ slot, variants }): DraftSlot => ({
        lineageId: slot.lineageId,
        sport: slot.sport,
        name: slot.name,
        targetDurationSeconds: slot.targetDurationSeconds,
        targetEffort: slot.targetEffort,
        targetValues: slot.targetValues,
        variants: variants.map(
          ({ variant, items }): DraftVariant => ({
            lineageId: variant.lineageId,
            name: variant.name,
            items: items.map(
              (item): DraftItem => ({
                lineageId: item.lineageId,
                exerciseId: item.exerciseId,
                sets: item.sets,
                target: itemTarget(item),
                targetRir: item.targetRir,
                restSeconds: item.restSeconds,
                restAfterSeconds: item.restAfterSeconds,
              }),
            ),
          }),
        ),
      }),
    ),
  };
}

export function withFreshLineages(draft: ProgramDraft, newId: () => Id): ProgramDraft {
  return {
    ...draft,
    slots: draft.slots.map((slot) => ({
      ...slot,
      lineageId: newId(),
      variants: slot.variants.map((variant) => ({
        ...variant,
        lineageId: newId(),
        items: variant.items.map((item) => ({ ...item, lineageId: newId() })),
      })),
    })),
  };
}
