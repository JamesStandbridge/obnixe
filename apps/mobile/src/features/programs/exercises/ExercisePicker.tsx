import { useMemo, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { findExerciseByName, searchExercises } from "@obnixe/core";
import type { ZonePain } from "@obnixe/core";
import type { Exercise, Id, ZoneKey } from "@obnixe/schema";
import { worstPain } from "@/features/programs/data";
import { equipmentLabels, measureLabels, zoneLabel } from "@/features/programs/format";
import { ControlButton, LinkButton } from "@/ui/Button";
import { PainMark } from "@/ui/Controls";
import { IconButton, TextField } from "@/ui/Inputs";
import { Icon } from "@/ui/icons/Icon";
import { Text } from "@/ui/Text";
import { useTheme } from "@/ui/theme";

const maxResults = 40;


interface ExercisePickerProps {
  readonly exercises: readonly Exercise[];
  readonly zones: ReadonlyMap<Id, readonly ZoneKey[]>;
  readonly pain: ReadonlyMap<ZoneKey, ZonePain>;
  readonly initialQuery: string;
  readonly currentId: Id | null;
  readonly onPick: (exercise: Exercise) => void;
  readonly onCreate: (name: string) => void;
  readonly onEdit: (exercise: Exercise, query: string) => void;
  readonly onRestore: (exercise: Exercise) => void;
}

export function ExercisePicker({ exercises, zones, pain, initialQuery, currentId, onPick, onCreate, onEdit, onRestore }: ExercisePickerProps) {
  const { colors } = useTheme();
  const [query, setQuery] = useState(initialQuery);
  const [showArchived, setShowArchived] = useState(false);
  const results = useMemo(() => searchExercises(exercises, query).slice(0, maxResults), [exercises, query]);
  const archived = useMemo(() => exercises.filter((exercise) => exercise.archivedAt !== null && exercise.mergedIntoId === null).sort((left, right) => left.nameKey.localeCompare(right.nameKey)), [exercises]);
  const exact = query.trim() === "" ? null : findExerciseByName(exercises, query);
  const painOf = (exercise: Exercise): ZonePain | null => worstPain(zones.get(exercise.id) ?? [], pain);

  return (
    <View>
      <TextField
        value={query}
        onChangeText={setQuery}
        placeholder="Rechercher ou créer"
        accessibilityLabel="Rechercher un exercice"
        autoCorrect={false}
        autoCapitalize="sentences"
        returnKeyType="done"
      />
      <View style={styles.list}>
        {results.map((exercise) => {
          const zonePain = painOf(exercise);
          const detail = `${equipmentLabels[exercise.equipment]} · ${measureLabels[exercise.measure]}${exercise.zonesReviewed ? "" : " · zones à vérifier"}`;
          return (
            <View key={exercise.id} style={[styles.row, { borderTopColor: colors.line }]}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`${exercise.name}, ${detail}${zonePain === null ? "" : `, ${zoneLabel(zonePain.zone)} ${zonePain.level === "stop" ? "arrêt" : "gêne"}`}`}
                accessibilityState={{ selected: exercise.id === currentId }}
                onPress={() => onPick(exercise)}
                style={({ pressed }) => [styles.pick, pressed && { backgroundColor: colors.surfacePress }]}
              >
                <Text variant="bodyStrong" numberOfLines={1}>
                  {exercise.name}
                </Text>
                <View style={styles.meta}>
                  <Text variant="small" tone="secondary">
                    {detail}
                  </Text>
                  {zonePain === null ? null : <PainMark level={zonePain.level} />}
                </View>
              </Pressable>
              {exercise.id === currentId ? <Icon name="check" color={colors.text} /> : null}
              <IconButton icon="edit" label={`Modifier ${exercise.name}`} edge="end" onPress={() => onEdit(exercise, query)} />
            </View>
          );
        })}
        {exact === null && query.trim() !== "" ? (
          <Pressable
            accessibilityRole="button"
            onPress={() => onCreate(query.trim())}
            style={({ pressed }) => [styles.create, { borderTopColor: colors.line }, pressed && { backgroundColor: colors.surfacePress }]}
          >
            <Icon name="plus" color={colors.text} />
            <Text variant="bodyStrong" numberOfLines={1} style={styles.createLabel}>
              Créer « {query.trim()} »
            </Text>
          </Pressable>
        ) : null}
        {exact !== null && exact.archivedAt !== null ? (
          <Text variant="small" tone="secondary" style={styles.hint}>
            « {exact.name} » est archivé. Restaure-le ci-dessous pour l'utiliser.
          </Text>
        ) : null}
        {results.length === 0 && query.trim() === "" ? (
          <Text tone="secondary" style={styles.hint}>
            Aucun exercice pour l'instant. Tape un nom pour créer le premier.
          </Text>
        ) : null}
      </View>
      {query.trim() === "" ? <ControlButton label="Nouvel exercice" icon={<Icon name="plus" size={18} />} onPress={() => onCreate("")} style={styles.newButton} /> : null}
      {archived.length === 0 ? null : (
        <LinkButton label={showArchived ? "Masquer les archivés" : `Exercices archivés (${archived.length})`} onPress={() => setShowArchived((value) => !value)} style={styles.archivedToggle} />
      )}
      {showArchived
        ? archived.map((exercise) => (
            <View key={exercise.id} style={[styles.row, { borderTopColor: colors.line }]}>
              <View style={styles.pick}>
                <Text variant="bodyStrong" tone="secondary" numberOfLines={1}>
                  {exercise.name}
                </Text>
                <Text variant="small" tone="secondary">
                  archivé
                </Text>
              </View>
              <LinkButton label="Restaurer" onPress={() => onRestore(exercise)} />
            </View>
          ))
        : null}
    </View>
  );
}

const styles = StyleSheet.create({
  list: { marginTop: 8 },
  row: { flexDirection: "row", alignItems: "center", gap: 8, borderTopWidth: 1 },
  pick: { flex: 1, minWidth: 0, minHeight: 60, justifyContent: "center", gap: 3, paddingVertical: 8 },
  meta: { flexDirection: "row", alignItems: "center", gap: 6 },
  create: { flexDirection: "row", alignItems: "center", gap: 12, minHeight: 60, borderTopWidth: 1 },
  createLabel: { flex: 1 },
  hint: { marginTop: 12 },
  newButton: { marginTop: 12 },
  archivedToggle: { alignSelf: "flex-start", marginLeft: -10, marginTop: 8 },
});
