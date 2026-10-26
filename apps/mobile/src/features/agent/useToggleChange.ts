import { useCallback } from "react";
import { AlreadyRevertedError, DependentRowsError, RevertConflictError, toggleChange } from "@obnixe/core";
import type { Id } from "@obnixe/schema";
import { db, environment } from "@/data/database";
import { userActor } from "@/data/write";
import { useSnackbar } from "@/ui/SnackbarHost";

export interface ToggleTarget {
  readonly changesetId: Id;
  readonly summary: string;
}

export function useToggleChange(extraOffset: number): (target: ToggleTarget) => void {
  const notify = useSnackbar();
  const toggle = useCallback(
    (target: ToggleTarget): void => {
      const placement = { aboveTabBar: false, extraOffset } as const;
      let result: ReturnType<typeof toggleChange>;
      try {
        result = toggleChange(db(), environment, userActor, target.changesetId, target.summary);
      } catch (error) {
        if (error instanceof RevertConflictError || error instanceof DependentRowsError || error instanceof AlreadyRevertedError) {
          notify({ text: "Impossible d'annuler : modifié depuis", ...placement });
          return;
        }
        throw error;
      }
      const text = result.reverted ? (result.publishedVersion ? "Modification annulée · nouvelle version enregistrée" : "Modification annulée") : "Modification rétablie";
      notify({ text, ...placement, action: { label: result.reverted ? "Rétablir" : "Annuler", run: () => toggle(target) } });
    },
    [notify, extraOffset],
  );
  return toggle;
}
