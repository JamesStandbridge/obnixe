import { useCallback, useMemo } from "react";
import {
  AlreadyRevertedError,
  DependentRowsError,
  RevertConflictError,
  draftFromTree,
  exerciseRefs,
  latestVersion,
  loadVersionTree,
  planActivate,
  planArchive,
  planCreateProgram,
  planSkipNextSlot,
  withFreshLineages,
} from "@obnixe/core";
import type { ProgramEntry, VersionEntry } from "@obnixe/core";
import { exercise, program } from "@obnixe/schema";
import type { Id, ProgramSlot } from "@obnixe/schema";
import { db, environment } from "@/data/database";
import { undo, useUndoableWrite } from "@/data/write";
import { deviceTimeZone } from "@/format/dates";
import { issueMessage } from "@/features/programs/format";
import type { ExerciseName } from "@/features/programs/format";
import { versionTitle } from "@/features/programs/VersionRows";
import { useSnackbar } from "@/ui/SnackbarHost";

export function skipLabel(slot: ProgramSlot): string {
  const match = /^Séance (.+)$/.exec(slot.name.trim());
  return match?.[1] === undefined ? "Passer cette séance" : `Passer la ${match[1]}`;
}

export interface ProgramActions {
  readonly activate: (entry: ProgramEntry) => void;
  readonly archive: (entry: ProgramEntry) => void;
  readonly duplicate: (entry: ProgramEntry) => Id | null;
  readonly skip: () => void;
  readonly revertVersion: (entry: VersionEntry) => void;
}

export function useProgramActions(name: ExerciseName): ProgramActions {
  const undoable = useUndoableWrite();
  const notify = useSnackbar();

  const activate = useCallback(
    (entry: ProgramEntry) => {
      const plan = planActivate(db().select().from(program).all(), entry.program.id);
      if (!plan.ok) return;
      const archivedName = plan.archived === null ? null : (latestVersion(db(), plan.archived.id)?.name ?? null);
      undoable({
        summary: `Activation : ${entry.version.name}`,
        mutations: plan.mutations,
        message: archivedName === null ? `${entry.version.name} actif` : `${entry.version.name} actif · ${archivedName} archivé`,
      });
    },
    [undoable],
  );

  const archive = useCallback(
    (entry: ProgramEntry) => {
      const plan = planArchive(entry.program);
      if (!plan.ok) return;
      undoable({ summary: `Archivage : ${entry.version.name}`, mutations: plan.mutations, message: `${entry.version.name} archivé` });
    },
    [undoable],
  );

  const duplicate = useCallback(
    (entry: ProgramEntry) => {
      const tree = loadVersionTree(db(), entry.version.id);
      if (tree === null) return null;
      const draft = withFreshLineages(draftFromTree(tree), environment.newId);
      const copy = { ...draft, name: `${draft.name} (copie)` };
      const result = planCreateProgram(
        {
          draft: copy,
          status: "draft",
          copiedFromId: entry.version.id,
          summary: `Copie de ${entry.version.name}`,
          reason: null,
          exercises: exerciseRefs(db().select().from(exercise).all()),
        },
        environment.newId,
      );
      if (!result.ok) {
        notify({ text: `Copie impossible : ${issueMessage(result.issues[0], copy, name)}` });
        return null;
      }
      undoable({ summary: `Copie de ${entry.version.name}`, mutations: result.plan.mutations, message: "Copie créée en brouillon" });
      return result.plan.programId;
    },
    [undoable, notify, name],
  );

  const skip = useCallback(() => {
    const plan = planSkipNextSlot(db(), { now: environment.now(), timeZone: deviceTimeZone(), newId: environment.newId });
    if (plan === null) return;
    undoable({ summary: `${plan.skipped.name} passée`, mutations: [plan.mutation], message: `${plan.skipped.name} passée · prochaine : ${plan.next.name}` });
  }, [undoable]);

  const revertVersion = useCallback(
    (entry: VersionEntry) => {
      const blocked = (): void => notify({ text: "Impossible d'annuler : modifié depuis" });
      let revertId: Id;
      try {
        revertId = undo(entry.changesetId, versionTitle(entry));
      } catch (error) {
        if (error instanceof RevertConflictError || error instanceof DependentRowsError || error instanceof AlreadyRevertedError) {
          blocked();
          return;
        }
        throw error;
      }
      notify({
        text: `Changement annulé · enregistré comme v${entry.version.number + 1}`,
        action: {
          label: "Annuler",
          run: () => {
            try {
              undo(revertId, `Annulation de v${entry.version.number}`);
            } catch (error) {
              if (error instanceof RevertConflictError || error instanceof DependentRowsError || error instanceof AlreadyRevertedError) {
                blocked();
                return;
              }
              throw error;
            }
          },
        },
      });
    },
    [notify],
  );

  return useMemo(() => ({ activate, archive, duplicate, skip, revertVersion }), [activate, archive, duplicate, skip, revertVersion]);
}
