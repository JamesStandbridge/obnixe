import { useCallback } from "react";
import { DependentRowsError, RevertConflictError, commit, revert } from "@obnixe/core";
import type { Actor, Mutation } from "@obnixe/core";
import type { Id } from "@obnixe/schema";
import { db, environment } from "@/data/database";
import { useSnackbar } from "@/ui/SnackbarHost";
import type { SnackbarMessage } from "@/ui/SnackbarHost";

export const userActor: Actor = { author: "user", connectionId: null };

export function write(summary: string, mutations: readonly Mutation[]): Id {
  return commit(db(), environment, { actor: userActor, summary, revertsId: null, mutations });
}

export function undo(changesetId: Id, summary: string): Id {
  return revert(db(), environment, {
    actor: userActor,
    changesetId,
    summary: `Annulation : ${summary}`,
    restoredVersionSummary: (restoredNumber) => `Retour à la v${restoredNumber}`,
  });
}

export interface UndoableWrite {
  readonly summary: string;
  readonly mutations: readonly Mutation[];
  readonly message: string;
  readonly aboveTabBar?: boolean;
  readonly extraOffset?: number;
  readonly onUndone?: () => void;
}

export function useUndoableWrite(): (request: UndoableWrite) => Id {
  const notify = useSnackbar();
  return useCallback(
    (request: UndoableWrite) => {
      const changesetId = write(request.summary, request.mutations);
      const placement: Pick<SnackbarMessage, "aboveTabBar" | "extraOffset"> = {
        ...(request.aboveTabBar === undefined ? {} : { aboveTabBar: request.aboveTabBar }),
        ...(request.extraOffset === undefined ? {} : { extraOffset: request.extraOffset }),
      };
      notify({
        text: request.message,
        ...placement,
        action: {
          label: "Annuler",
          run: () => {
            try {
              undo(changesetId, request.summary);
            } catch (error) {
              if (error instanceof RevertConflictError || error instanceof DependentRowsError) {
                notify({ text: "Impossible d'annuler : modifié depuis", ...placement });
                return;
              }
              throw error;
            }
            request.onUndone?.();
          },
        },
      });
      return changesetId;
    },
    [notify],
  );
}
