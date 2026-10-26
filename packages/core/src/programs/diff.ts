import type { Id } from "@obnixe/schema";
import type { DraftItem, DraftSlot, DraftVariant, ItemTarget, ProgramDraft } from "./draft.ts";

export type SlotField = "name" | "sport" | "target_duration" | "target_effort" | "target_values";
export type ItemField = "exercise" | "sets" | "target" | "rir" | "rest" | "rest_after";

export interface VariantContext {
  readonly slot: DraftSlot;
  readonly variant: DraftVariant;
}

export type ProgramChange =
  | { readonly kind: "program_renamed"; readonly before: string; readonly after: string }
  | { readonly kind: "frequency_changed"; readonly before: number; readonly after: number }
  | { readonly kind: "slot_added"; readonly slot: DraftSlot }
  | { readonly kind: "slot_removed"; readonly slot: DraftSlot }
  | { readonly kind: "slot_changed"; readonly before: DraftSlot; readonly after: DraftSlot; readonly fields: readonly [SlotField, ...SlotField[]] }
  | { readonly kind: "slots_reordered"; readonly before: readonly DraftSlot[]; readonly after: readonly DraftSlot[] }
  | { readonly kind: "variant_added"; readonly slot: DraftSlot; readonly variant: DraftVariant }
  | { readonly kind: "variant_removed"; readonly slot: DraftSlot; readonly variant: DraftVariant }
  | { readonly kind: "variant_renamed"; readonly slot: DraftSlot; readonly before: DraftVariant; readonly after: DraftVariant }
  | { readonly kind: "variants_reordered"; readonly slot: DraftSlot }
  | ({ readonly kind: "item_added"; readonly item: DraftItem } & VariantContext)
  | ({ readonly kind: "item_removed"; readonly item: DraftItem } & VariantContext)
  | ({ readonly kind: "item_replaced"; readonly before: DraftItem; readonly after: DraftItem } & VariantContext)
  | ({ readonly kind: "item_changed"; readonly before: DraftItem; readonly after: DraftItem; readonly fields: readonly [ItemField, ...ItemField[]] } & VariantContext)
  | ({ readonly kind: "items_reordered" } & VariantContext);

interface Lineaged {
  readonly lineageId: Id;
}

interface Matched<T extends Lineaged> {
  readonly added: readonly T[];
  readonly removed: readonly T[];
  readonly kept: readonly { readonly before: T; readonly after: T }[];
  readonly reordered: boolean;
}

function match<T extends Lineaged>(before: readonly T[], after: readonly T[]): Matched<T> {
  const afterIds = new Set(after.map((element) => element.lineageId));
  const beforeById = new Map(before.map((element) => [element.lineageId, element]));
  const kept: { readonly before: T; readonly after: T }[] = [];
  for (const element of after) {
    const previous = beforeById.get(element.lineageId);
    if (previous !== undefined) kept.push({ before: previous, after: element });
  }
  const beforeOrder = before.filter((element) => afterIds.has(element.lineageId)).map((element) => element.lineageId);
  const afterOrder = kept.map((pair) => pair.after.lineageId);
  return {
    added: after.filter((element) => !beforeById.has(element.lineageId)),
    removed: before.filter((element) => !afterIds.has(element.lineageId)),
    kept,
    reordered: beforeOrder.some((id, index) => afterOrder[index] !== id),
  };
}

function nonEmpty<T>(values: readonly T[]): readonly [T, ...T[]] | null {
  const [first, ...rest] = values;
  return first === undefined ? null : [first, ...rest];
}

function sameValues(left: unknown, right: unknown): boolean {
  return canonical(left) === canonical(right);
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sameTarget(left: ItemTarget, right: ItemTarget): boolean {
  return sameValues(left, right);
}

function slotFields(before: DraftSlot, after: DraftSlot): SlotField[] {
  const fields: SlotField[] = [];
  if (before.name.trim() !== after.name.trim()) fields.push("name");
  if (before.sport !== after.sport) fields.push("sport");
  if (before.targetDurationSeconds !== after.targetDurationSeconds) fields.push("target_duration");
  if (before.targetEffort !== after.targetEffort) fields.push("target_effort");
  if (!sameValues(before.targetValues, after.targetValues)) fields.push("target_values");
  return fields;
}

function itemFields(before: DraftItem, after: DraftItem): ItemField[] {
  const fields: ItemField[] = [];
  if (before.exerciseId !== after.exerciseId) fields.push("exercise");
  if (before.sets !== after.sets) fields.push("sets");
  if (!sameTarget(before.target, after.target)) fields.push("target");
  if (before.targetRir !== after.targetRir) fields.push("rir");
  if (before.restSeconds !== after.restSeconds) fields.push("rest");
  if (before.restAfterSeconds !== after.restAfterSeconds) fields.push("rest_after");
  return fields;
}

function itemChanges(slot: DraftSlot, before: DraftVariant, after: DraftVariant): ProgramChange[] {
  const context: VariantContext = { slot, variant: after };
  const matched = match(before.items, after.items);
  const changes: ProgramChange[] = [];
  const added = [...matched.added];
  for (const removed of matched.removed) {
    const position = before.items.indexOf(removed);
    const replacement = added.find((item) => after.items.indexOf(item) === position);
    if (replacement === undefined) {
      changes.push({ kind: "item_removed", item: removed, ...context });
      continue;
    }
    added.splice(added.indexOf(replacement), 1);
    changes.push({ kind: "item_replaced", before: removed, after: replacement, ...context });
  }
  for (const item of added) changes.push({ kind: "item_added", item, ...context });
  for (const pair of matched.kept) {
    const fields = nonEmpty(itemFields(pair.before, pair.after));
    if (fields !== null) changes.push({ kind: "item_changed", before: pair.before, after: pair.after, fields, ...context });
  }
  if (matched.reordered) changes.push({ kind: "items_reordered", ...context });
  return changes;
}

function variantChanges(before: DraftSlot, after: DraftSlot): ProgramChange[] {
  const matched = match(before.variants, after.variants);
  const changes: ProgramChange[] = [];
  for (const variant of matched.removed) changes.push({ kind: "variant_removed", slot: after, variant });
  for (const variant of matched.added) changes.push({ kind: "variant_added", slot: after, variant });
  for (const pair of matched.kept) {
    if (pair.before.name.trim() !== pair.after.name.trim()) changes.push({ kind: "variant_renamed", slot: after, before: pair.before, after: pair.after });
    changes.push(...itemChanges(after, pair.before, pair.after));
  }
  if (matched.reordered) changes.push({ kind: "variants_reordered", slot: after });
  return changes;
}

export function diffDrafts(before: ProgramDraft, after: ProgramDraft): ProgramChange[] {
  const changes: ProgramChange[] = [];
  if (before.name.trim() !== after.name.trim()) changes.push({ kind: "program_renamed", before: before.name.trim(), after: after.name.trim() });
  if (before.sessionsPerWeek !== after.sessionsPerWeek) changes.push({ kind: "frequency_changed", before: before.sessionsPerWeek, after: after.sessionsPerWeek });
  const matched = match(before.slots, after.slots);
  for (const slot of matched.removed) changes.push({ kind: "slot_removed", slot });
  for (const slot of matched.added) changes.push({ kind: "slot_added", slot });
  for (const pair of matched.kept) {
    const fields = nonEmpty(slotFields(pair.before, pair.after));
    if (fields !== null) changes.push({ kind: "slot_changed", before: pair.before, after: pair.after, fields });
    changes.push(...variantChanges(pair.before, pair.after));
  }
  if (matched.reordered) changes.push({ kind: "slots_reordered", before: before.slots, after: after.slots });
  return changes;
}

export function changedItemLineages(changes: readonly ProgramChange[]): ReadonlySet<Id> {
  const lineages = new Set<Id>();
  for (const change of changes) {
    switch (change.kind) {
      case "item_added":
        lineages.add(change.item.lineageId);
        break;
      case "item_replaced":
      case "item_changed":
        lineages.add(change.after.lineageId);
        break;
      case "variant_added":
        for (const item of change.variant.items) lineages.add(item.lineageId);
        break;
      case "slot_added":
        for (const variant of change.slot.variants) for (const item of variant.items) lineages.add(item.lineageId);
        break;
      case "program_renamed":
      case "frequency_changed":
      case "slot_removed":
      case "slot_changed":
      case "slots_reordered":
      case "variant_removed":
      case "variant_renamed":
      case "variants_reordered":
      case "item_removed":
      case "items_reordered":
        break;
      default: {
        const unreachable: never = change;
        throw new Error(`Unhandled program change ${JSON.stringify(unreachable)}`);
      }
    }
  }
  return lineages;
}
