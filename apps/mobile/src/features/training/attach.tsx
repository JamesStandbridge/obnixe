import { useCallback } from "react";
import { attachSessionMutation } from "@obnixe/core";
import type { CycleSlot, CycleSlotState } from "@obnixe/core";
import { sports } from "@obnixe/schema";
import type { Id, LocalDate, ProgramSlot, Session } from "@obnixe/schema";
import { useUndoableWrite } from "@/data/write";
import { relativeDay } from "@/format/dates";
import { lowerFirst } from "@/format/labels";
import { SportIcon } from "@/ui/icons/SportIcon";
import { MenuItem } from "@/ui/Inputs";

export interface PositionedSlot {
  readonly entry: CycleSlot;
  readonly position: number;
}

export function positioned(cycle: readonly CycleSlot[], entries: readonly CycleSlot[]): readonly PositionedSlot[] {
  return entries.map((entry) => ({ entry, position: cycle.indexOf(entry) + 1 }));
}

function stateText(state: CycleSlotState, today: LocalDate): string {
  switch (state.kind) {
    case "done":
      return `faite ${relativeDay(state.localDate, today)}`;
    case "skipped":
      return `passée ${relativeDay(state.localDate, today)}`;
    case "next":
      return "prochaine";
    case "pending":
      return "à faire";
    default: {
      const unreachable: never = state;
      throw new Error(`Unhandled cycle state ${String(unreachable)}`);
    }
  }
}

interface SlotMenuItemProps {
  readonly slot: PositionedSlot;
  readonly today: LocalDate;
  readonly current?: boolean;
  readonly onPress: () => void;
}

export function SlotMenuItem({ slot, today, current = false, onPress }: SlotMenuItemProps) {
  const { entry, position } = slot;
  const detail = current ? "cette séance" : stateText(entry.state, today);
  return (
    <MenuItem
      label={entry.slot.name}
      detail={`Séance ${position} · ${detail}`}
      leading={<SportIcon sport={entry.slot.sport} variant="badge" label={sports[entry.slot.sport].label} />}
      onPress={onPress}
    />
  );
}

export interface AttachRequest {
  readonly session: Pick<Session, "id" | "slotId" | "variantId">;
  readonly slot: ProgramSlot | null;
  readonly title: string;
  readonly extraOffset: number;
}

export function useAttachSession(): (request: AttachRequest) => Id {
  const undoableWrite = useUndoableWrite();
  return useCallback(
    ({ session, slot, title, extraOffset }: AttachRequest) =>
      undoableWrite({
        summary: slot === null ? `Hors programme : ${title}` : `Compte comme ${slot.name} : ${title}`,
        mutations: [attachSessionMutation(session, slot?.id ?? null)],
        message: slot === null ? "Hors programme" : `Compte comme ${lowerFirst(slot.name)}`,
        aboveTabBar: false,
        extraOffset,
      }),
    [undoableWrite],
  );
}
