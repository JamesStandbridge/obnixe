import { useEffect, useMemo, useState } from "react";
import { StyleSheet, View } from "react-native";
import { and, asc, isNull } from "drizzle-orm";
import { exercise as exerciseTable, exerciseCuesMaxLength, exerciseNameKey } from "@obnixe/schema";
import type { Exercise, Id } from "@obnixe/schema";
import { db } from "@/data/database";
import { equipmentLabels } from "@/features/training/format";
import { AddExercise } from "@/features/training/workout/AddExercise";
import { LinkButton, SheetButton } from "@/ui/Button";
import { MenuItem, TextField } from "@/ui/Inputs";
import { Row } from "@/ui/Layout";
import { Sheet } from "@/ui/Overlays";
import { Text } from "@/ui/Text";
import { useTheme } from "@/ui/theme";
import { fonts, radii } from "@/ui/tokens";

export type ExerciseSheetMode = "menu" | "cues" | "replace" | "add";

interface ExerciseSheetProps {
  readonly open: boolean;
  readonly mode: ExerciseSheetMode;
  readonly title: string;
  readonly sessionTitle: string;
  readonly exerciseId: Id | null;
  readonly cues: string | null;
  readonly canChange: boolean;
  readonly canPostpone: boolean;
  readonly onMode: (mode: ExerciseSheetMode) => void;
  readonly onSaveCues: (text: string) => void;
  readonly onSkip: () => void;
  readonly onPostpone: () => void;
  readonly onReplace: (exercise: Exercise) => void;
  readonly onAdd: (exercise: Exercise) => void;
  readonly onHistory: () => void;
  readonly onLeave: () => void;
  readonly onFinish: () => void;
  readonly onClose: () => void;
}

export function ExerciseSheet({
  open,
  mode,
  title,
  sessionTitle,
  exerciseId,
  cues,
  canChange,
  canPostpone,
  onMode,
  onSaveCues,
  onSkip,
  onPostpone,
  onReplace,
  onAdd,
  onHistory,
  onLeave,
  onFinish,
  onClose,
}: ExerciseSheetProps) {
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

  if (mode === "cues") {
    return (
      <Sheet open={open} title="Consignes" context={title} onClose={onClose}>
        <Cues key={exerciseId ?? ""} cues={cues} onSave={onSaveCues} onBack={() => onMode("menu")} />
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
        {exerciseId === null ? null : <MenuItem label="Consignes" detail={cues === null ? "Placement, amplitude, respiration" : (cues.split("\n")[0] ?? "")} onPress={() => onMode("cues")} />}
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

interface CuesProps {
  readonly cues: string | null;
  readonly onSave: (text: string) => void;
  readonly onBack: () => void;
}

function Cues({ cues, onSave, onBack }: CuesProps) {
  const { colors } = useTheme();
  const [draft, setDraft] = useState<string | null>(cues === null ? "" : null);

  if (draft === null && cues !== null) {
    return (
      <View>
        <View style={[styles.cues, { backgroundColor: colors.surface }]}>
          {cues.split("\n").map((line, index) =>
            line === "" ? (
              <View key={index} style={styles.cueGap} />
            ) : (
              <Text key={index} style={styles.cueLine}>
                {line}
              </Text>
            ),
          )}
        </View>
        <View style={styles.cueActions}>
          <LinkButton label="Retour" onPress={onBack} />
          <LinkButton label="Modifier" onPress={() => setDraft(cues)} />
        </View>
      </View>
    );
  }

  return (
    <View>
      <TextField
        value={draft ?? ""}
        onChangeText={setDraft}
        multiline
        autoFocus={cues === null}
        maxLength={exerciseCuesMaxLength}
        placeholder={"Placement, amplitude, respiration…\nUne consigne par ligne"}
        accessibilityLabel="Consignes de l'exercice"
        style={styles.cueField}
      />
      <SheetButton label="Enregistrer" onPress={() => onSave(draft ?? "")} style={styles.save} />
      <LinkButton label={cues === null ? "Retour" : "Annuler"} onPress={cues === null ? onBack : () => setDraft(null)} style={styles.cancel} />
    </View>
  );
}

const styles = StyleSheet.create({
  menu: { marginTop: 8 },
  list: { marginTop: 8 },
  empty: { paddingVertical: 16 },
  cues: { marginTop: 8, paddingVertical: 14, paddingHorizontal: 16, borderRadius: radii.panel, gap: 6 },
  cueLine: { fontFamily: fonts.text500, fontSize: 17, lineHeight: 24 },
  cueGap: { height: 6 },
  cueActions: { marginTop: 8, flexDirection: "row", justifyContent: "space-between" },
  cueField: { marginTop: 8, minHeight: 140 },
  save: { marginTop: 12 },
  cancel: { marginTop: 4, alignSelf: "center" },
});
