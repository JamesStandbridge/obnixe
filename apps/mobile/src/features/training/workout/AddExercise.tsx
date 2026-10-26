import { useEffect, useState } from "react";
import { StyleSheet, View } from "react-native";
import { eq } from "drizzle-orm";
import { exerciseUsage, planRestoreExercise } from "@obnixe/core";
import { exercise as exerciseTable } from "@obnixe/schema";
import type { Exercise, Id } from "@obnixe/schema";
import { db } from "@/data/database";
import { write } from "@/data/write";
import { useExerciseCatalog, useRevision, useZonePain } from "@/features/programs/data";
import { ExerciseForm } from "@/features/programs/exercises/ExerciseForm";
import { ExercisePicker } from "@/features/programs/exercises/ExercisePicker";
import { useMassUnit } from "@/data/settings";
import { LinkButton } from "@/ui/Button";

type Step = { readonly kind: "pick"; readonly query: string } | { readonly kind: "form"; readonly exerciseId: Id | null; readonly name: string; readonly query: string };

const initialStep: Step = { kind: "pick", query: "" };

function readExercise(id: Id): Exercise | null {
  return db().select().from(exerciseTable).where(eq(exerciseTable.id, id)).get() ?? null;
}

interface AddExerciseProps {
  readonly open: boolean;
  readonly onAdd: (exercise: Exercise) => void;
}

export function AddExercise({ open, onAdd }: AddExerciseProps) {
  const catalog = useExerciseCatalog();
  const pain = useZonePain(useRevision());
  const massUnit = useMassUnit();
  const [step, setStep] = useState<Step>(initialStep);
  useEffect(() => {
    if (open) setStep(initialStep);
  }, [open]);

  switch (step.kind) {
    case "pick":
      return (
        <ExercisePicker
          key={step.query}
          exercises={catalog.exercises}
          zones={catalog.zones}
          pain={pain}
          initialQuery={step.query}
          currentId={null}
          onPick={onAdd}
          onCreate={(name) => setStep({ kind: "form", exerciseId: null, name, query: name })}
          onEdit={(picked, query) => setStep({ kind: "form", exerciseId: picked.id, name: picked.name, query })}
          onRestore={(picked) => {
            const mutation = planRestoreExercise(picked);
            if (mutation !== null) write(`Exercice restauré : ${picked.name}`, [mutation]);
          }}
        />
      );
    case "form": {
      const current = step.exerciseId === null ? null : readExercise(step.exerciseId);
      const backToPicker = (): void => setStep({ kind: "pick", query: step.query });
      return (
        <View>
          <LinkButton label="Retour à la liste" onPress={backToPicker} style={styles.back} />
          <ExerciseForm
            key={step.exerciseId ?? `new-${step.name}`}
            exercise={current}
            exerciseZones={current === null ? [] : (catalog.zones.get(current.id) ?? [])}
            usage={current === null ? { inUse: false, programNames: [] } : exerciseUsage(db(), current.id)}
            initialName={step.name}
            exercises={catalog.exercises}
            massUnit={massUnit}
            onDone={(exerciseId) => {
              const saved = readExercise(exerciseId);
              if (current === null && saved !== null) onAdd(saved);
              else backToPicker();
            }}
            onArchived={backToPicker}
          />
        </View>
      );
    }
    default: {
      const unreachable: never = step;
      return unreachable;
    }
  }
}

const styles = StyleSheet.create({
  back: { alignSelf: "flex-start", marginLeft: -10, marginBottom: 4 },
});
