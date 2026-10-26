import { useEffect, useMemo, useState } from "react";
import { StyleSheet, View } from "react-native";
import { and, asc, isNull } from "drizzle-orm";
import { exercise as exerciseTable, exerciseNameKey } from "@obnixe/schema";
import type { Exercise, Id } from "@obnixe/schema";
import { db } from "@/data/database";
import { equipmentLabels } from "@/features/training/format";
import { AddExercise } from "@/features/training/workout/AddExercise";
import { MenuItem, TextField } from "@/ui/Inputs";
import { Row } from "@/ui/Layout";
import { Sheet } from "@/ui/Overlays";
import { Text } from "@/ui/Text";

export type ExerciseSheetMode = "menu" | "replace" | "add";

interface ExerciseSheetProps {
  readonly open: boolean;
  readonly mode: ExerciseSheetMode;
  readonly title: string;
  readonly sessionTitle: string;
  readonly exerciseId: Id | null;
  readonly canChange: boolean;
  readonly canPostpone: boolean;
  readonly onMode: (mode: ExerciseSheetMode) => void;
  readonly onSkip: () => void;
  readonly onPostpone: () => void;
  readonly onReplace: (exercise: Exercise) => void;
  readonly onAdd: (exercise: Exercise) => void;
  readonly onHistory: () => void;
  readonly onLeave: () => void;
  readonly onFinish: () => void;
  readonly onClose: () => void;
}

export function ExerciseSheet({ open, mode, title, sessionTitle, exerciseId, canChange, canPostpone, onMode, onSkip, onPostpone, onReplace, onAdd, onHistory, onLeave, onFinish, onClose }: ExerciseSheetProps) {
  const [query, setQuery] = useState("");
  useEffect(() => {
    if (open) setQuery("");
  }, [open, mode]);
  const candidates = useMemo(
    () =>
      open && mode === "replace"
        ? db()
            .select()
            .from(exerciseTable)
            .where(and(isNull(exerciseTable.archivedAt), isNull(exerciseTable.mergedIntoId)))
            .orderBy(asc(exerciseTable.nameKey))
            .all()
            .filter((candidate) => candidate.id !== exerciseId)
        : [],
    [open, mode, exerciseId],
  );
  const key = exerciseNameKey(query);
  const matches = key === "" ? candidates : candidates.filter((candidate) => candidate.nameKey.includes(key));

  if (mode === "add") {
    return (
      <Sheet open={open} title="Ajouter un exercice" context={sessionTitle} onClose={onClose}>
        <AddExercise open={open} onAdd={onAdd} />
      </Sheet>
    );
  }

  if (mode === "replace") {
    return (
      <Sheet open={open} title="Remplacer l'exercice" context={title} onClose={onClose}>
        <TextField value={query} onChangeText={setQuery} placeholder="Rechercher un exercice" accessibilityLabel="Rechercher un exercice" autoCorrect={false} returnKeyType="search" />
        <View style={styles.list}>
          {matches.length === 0 ? (
            <Text tone="secondary" style={styles.empty}>
              Aucun exercice
            </Text>
          ) : (
            matches.map((candidate, index) => (
              <Row key={candidate.id} title={candidate.name} detail={equipmentLabels[candidate.equipment]} onPress={() => onReplace(candidate)} last={index === matches.length - 1} />
            ))
          )}
        </View>
      </Sheet>
    );
  }

  return (
    <Sheet open={open} title={title} onClose={onClose}>
      <View style={styles.menu}>
        {canChange ? <MenuItem label="Passer l'exercice" onPress={onSkip} /> : null}
        {canChange && canPostpone ? <MenuItem label="Faire plus tard" detail="Après les autres exercices" onPress={onPostpone} /> : null}
        {canChange ? <MenuItem label="Remplacer l'exercice" onPress={() => onMode("replace")} /> : null}
        <MenuItem label="Ajouter un exercice" detail="À la fin de la séance" onPress={() => onMode("add")} />
        {exerciseId === null ? null : <MenuItem label="Historique" onPress={onHistory} />}
        <MenuItem label="Quitter la séance" detail="Reprise possible jusqu'à demain 6 h" onPress={onLeave} />
        <MenuItem label="Terminer la séance" detail="Les exercices restants seront passés" onPress={onFinish} />
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  menu: { marginTop: 8 },
  list: { marginTop: 8 },
  empty: { paddingVertical: 16 },
});
