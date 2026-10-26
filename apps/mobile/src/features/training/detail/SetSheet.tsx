import { useEffect, useState } from "react";
import { StyleSheet, View } from "react-native";
import { durationStepSeconds, gramsToMass, massToGrams } from "@obnixe/core";
import type { WorkoutExercise } from "@obnixe/core";
import type { MassUnit, StrengthSet } from "@obnixe/schema";
import { formatClock, formatNumber } from "@/features/training/format";
import { loadLimits, repsLimit, stepGramsFor } from "@/features/training/workout/liveWorkout";
import type { Draft } from "@/features/training/workout/liveWorkout";
import { LinkButton, SheetButton } from "@/ui/Button";
import { Stepper } from "@/ui/Controls";
import { Question, Scale } from "@/ui/Inputs";
import type { ScaleOption } from "@/ui/Inputs";
import { Sheet } from "@/ui/Overlays";
import { Text } from "@/ui/Text";

export interface SetTarget {
  readonly exercise: WorkoutExercise;
  readonly set: StrengthSet;
  readonly index: number;
}

interface SetSheetProps {
  readonly target: SetTarget | null;
  readonly unit: MassUnit;
  readonly onClose: () => void;
  readonly onSave: (target: SetTarget, draft: Draft) => void;
  readonly onDelete: (target: SetTarget) => void;
}

const rirOptions: readonly ScaleOption<number>[] = [
  { value: 0, label: "0", caption: "échec" },
  { value: 1, label: "1" },
  { value: 2, label: "2" },
  { value: 3, label: "3" },
  { value: 4, label: "4+", caption: "facile" },
];

function draftOf(set: StrengthSet): Draft {
  return { loadGrams: set.loadGrams, reps: set.reps, durationSeconds: set.durationSeconds, rir: set.rir };
}

export function SetSheet({ target, unit, onClose, onSave, onDelete }: SetSheetProps) {
  const [shown, setShown] = useState<SetTarget | null>(target);
  const [draft, setDraft] = useState<Draft | null>(target === null ? null : draftOf(target.set));
  useEffect(() => {
    if (target === null) return;
    setShown(target);
    setDraft(draftOf(target.set));
  }, [target]);

  if (shown === null || draft === null) return null;
  const measure = shown.exercise.exercise.measure;
  const step = gramsToMass(stepGramsFor(shown.exercise.exercise, unit), unit);
  const title = `Série ${shown.index + 1} · ${shown.exercise.exercise.name}`;
  return (
    <Sheet open={target !== null} title={title} onClose={onClose} {...(shown.set.interrupted ? { context: "Série interrompue" } : {})}>
      {shown.set.interrupted ? null : (
        <View>
          {measure === "load_reps" ? (
            <Question title="Charge">
              <Stepper
                value={gramsToMass(draft.loadGrams ?? 0, unit)}
                step={step}
                min={0}
                max={loadLimits[unit]}
                unit={unit}
                label="Charge"
                format={(value) => formatNumber(value)}
                onChange={(value) => setDraft({ ...draft, loadGrams: massToGrams(Math.round(value * 10) / 10, unit) })}
              />
            </Question>
          ) : null}
          {measure === "duration" ? (
            <Question title="Durée">
              <Stepper
                value={draft.durationSeconds ?? 0}
                step={durationStepSeconds}
                min={durationStepSeconds}
                max={3600}
                unit=""
                label="Durée"
                format={formatClock}
                onChange={(value) => setDraft({ ...draft, durationSeconds: value })}
              />
            </Question>
          ) : (
            <Question title="Répétitions">
              <Stepper value={draft.reps ?? 0} step={1} min={1} max={repsLimit} unit="rép." label="Répétitions" format={(value) => String(value)} onChange={(value) => setDraft({ ...draft, reps: value })} />
            </Question>
          )}
          <Question title="Réserve (RIR)">
            <Scale label="Répétitions en réserve" options={rirOptions} value={draft.rir === null ? null : Math.min(4, draft.rir)} onChange={(rir) => setDraft({ ...draft, rir })} optional />
          </Question>
          <SheetButton label="Enregistrer" onPress={() => onSave(shown, draft)} style={styles.save} />
        </View>
      )}
      <View style={styles.delete}>
        <LinkButton label="Supprimer la série" onPress={() => onDelete(shown)} />
        {shown.set.interrupted ? (
          <Text variant="small" tone="secondary">
            Une série interrompue ne se corrige pas.
          </Text>
        ) : null}
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  save: { marginTop: 20 },
  delete: { marginTop: 12, alignItems: "center", gap: 4 },
});
