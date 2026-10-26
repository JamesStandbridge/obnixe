import { moveByLineage, removeByLineage, updateItems, updateSlot, updateVariant, upsertByLineage } from "@obnixe/core";
import type { DraftItem, DraftSlot, DraftVariant, ProgramDraft } from "@obnixe/core";
import type { Id } from "@obnixe/schema";

export type SlotPatch = Partial<Omit<DraftSlot, "lineageId" | "variants">>;

export type DraftAction =
  | { readonly type: "reset"; readonly draft: ProgramDraft }
  | { readonly type: "rename"; readonly name: string }
  | { readonly type: "frequency"; readonly value: number }
  | { readonly type: "add_slot"; readonly slot: DraftSlot }
  | { readonly type: "update_slot"; readonly slotId: Id; readonly patch: SlotPatch }
  | { readonly type: "move_slot"; readonly slotId: Id; readonly offset: number }
  | { readonly type: "remove_slot"; readonly slotId: Id }
  | { readonly type: "add_variant"; readonly slotId: Id; readonly variant: DraftVariant }
  | { readonly type: "rename_variant"; readonly slotId: Id; readonly variantId: Id; readonly name: string }
  | { readonly type: "remove_variant"; readonly slotId: Id; readonly variantId: Id }
  | { readonly type: "save_item"; readonly slotId: Id; readonly variantId: Id; readonly item: DraftItem }
  | { readonly type: "move_item"; readonly slotId: Id; readonly variantId: Id; readonly itemId: Id; readonly offset: number }
  | { readonly type: "remove_item"; readonly slotId: Id; readonly variantId: Id; readonly itemId: Id };

export function draftReducer(draft: ProgramDraft, action: DraftAction): ProgramDraft {
  switch (action.type) {
    case "reset":
      return action.draft;
    case "rename":
      return { ...draft, name: action.name };
    case "frequency":
      return { ...draft, sessionsPerWeek: action.value };
    case "add_slot":
      return { ...draft, slots: [...draft.slots, action.slot] };
    case "update_slot":
      return updateSlot(draft, action.slotId, (slot) => ({ ...slot, ...action.patch }));
    case "move_slot":
      return { ...draft, slots: moveByLineage(draft.slots, action.slotId, action.offset) };
    case "remove_slot":
      return { ...draft, slots: removeByLineage(draft.slots, action.slotId) };
    case "add_variant":
      return updateSlot(draft, action.slotId, (slot) => ({ ...slot, variants: [...slot.variants, action.variant] }));
    case "rename_variant":
      return updateVariant(draft, action.slotId, action.variantId, (variant) => ({ ...variant, name: action.name }));
    case "remove_variant":
      return updateSlot(draft, action.slotId, (slot) => ({ ...slot, variants: removeByLineage(slot.variants, action.variantId) }));
    case "save_item":
      return updateItems(draft, action.slotId, action.variantId, (items) => upsertByLineage(items, action.item));
    case "move_item":
      return updateItems(draft, action.slotId, action.variantId, (items) => moveByLineage(items, action.itemId, action.offset));
    case "remove_item":
      return updateItems(draft, action.slotId, action.variantId, (items) => removeByLineage(items, action.itemId));
    default: {
      const unreachable: never = action;
      return unreachable;
    }
  }
}
