import type { Id } from "@obnixe/schema";
import type { DraftItem, DraftSlot, DraftVariant, ProgramDraft } from "./draft.ts";

interface Lineaged {
  readonly lineageId: Id;
}

export function moveByLineage<T extends Lineaged>(list: readonly T[], lineageId: Id, offset: number): readonly T[] {
  const from = list.findIndex((element) => element.lineageId === lineageId);
  const to = from + offset;
  if (from < 0 || to < 0 || to >= list.length) return list;
  const next = [...list];
  const [moved] = next.splice(from, 1);
  if (moved === undefined) return list;
  next.splice(to, 0, moved);
  return next;
}

export function replaceByLineage<T extends Lineaged>(list: readonly T[], lineageId: Id, update: (element: T) => T): readonly T[] {
  return list.map((element) => (element.lineageId === lineageId ? update(element) : element));
}

export function removeByLineage<T extends Lineaged>(list: readonly T[], lineageId: Id): readonly T[] {
  return list.filter((element) => element.lineageId !== lineageId);
}

export function upsertByLineage<T extends Lineaged>(list: readonly T[], element: T): readonly T[] {
  return list.some((existing) => existing.lineageId === element.lineageId) ? replaceByLineage(list, element.lineageId, () => element) : [...list, element];
}

export function updateSlot(draft: ProgramDraft, slotId: Id, update: (slot: DraftSlot) => DraftSlot): ProgramDraft {
  return { ...draft, slots: replaceByLineage(draft.slots, slotId, update) };
}

export function updateVariant(draft: ProgramDraft, slotId: Id, variantId: Id, update: (variant: DraftVariant) => DraftVariant): ProgramDraft {
  return updateSlot(draft, slotId, (slot) => ({ ...slot, variants: replaceByLineage(slot.variants, variantId, update) }));
}

export function updateItems(draft: ProgramDraft, slotId: Id, variantId: Id, update: (items: readonly DraftItem[]) => readonly DraftItem[]): ProgramDraft {
  return updateVariant(draft, slotId, variantId, (variant) => ({ ...variant, items: update(variant.items) }));
}

export function copyVariantItems(variant: DraftVariant, newId: () => Id): readonly DraftItem[] {
  return variant.items.map((item) => ({ ...item, lineageId: newId() }));
}
