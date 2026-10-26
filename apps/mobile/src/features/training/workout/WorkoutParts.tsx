import { Pressable, ScrollView, StyleSheet, View } from "react-native";
import { stoppedZones, worstLevel } from "@obnixe/core";
import type { PreviousPerformance, WorkoutExercise } from "@obnixe/core";
import type { Id, MassUnit, PainReport, StrengthSet, ZoneKey } from "@obnixe/schema";
import { formatMass, zoneLabel } from "@/features/training/format";
import { rangeText, setText, targetText } from "@/features/training/workout/liveWorkout";
import { PainMark } from "@/ui/Controls";
import { Text } from "@/ui/Text";
import { useTheme } from "@/ui/theme";
import { fonts, radii } from "@/ui/tokens";

interface StepsProps {
  readonly exercises: readonly WorkoutExercise[];
  readonly currentIndex: number | null;
  readonly displayIndex: number;
}

export function Steps({ exercises, currentIndex, displayIndex }: StepsProps) {
  const { colors } = useTheme();
  return (
    <View style={styles.progress}>
      <View style={styles.steps} accessible={false} importantForAccessibility="no-hide-descendants">
        {exercises.map((candidate, index) => {
          const now = index === currentIndex;
          const status = candidate.entry.status;
          return (
            <View
              key={candidate.entry.id}
              style={[
                styles.step,
                { backgroundColor: colors.surface2 },
                status === "done" && { backgroundColor: colors.stepDone },
                status === "stopped" && { backgroundColor: "transparent", borderWidth: 1.5, borderColor: colors.stop },
                now && [styles.stepNow, { backgroundColor: colors.mark }],
              ]}
            />
          );
        })}
      </View>
      <Text style={styles.stepsLabel} tone="secondary" accessibilityLabel={`Exercice ${displayIndex + 1} sur ${exercises.length}`}>
        {displayIndex + 1}/{exercises.length}
      </Text>
    </View>
  );
}

interface TrackProps {
  readonly exercise: WorkoutExercise;
  readonly previous: PreviousPerformance | null;
  readonly currentSetIndex: number | null;
  readonly editingSetId: Id | null;
  readonly pains: readonly PainReport[];
  readonly unit: MassUnit;
  readonly onEdit: (set: StrengthSet) => void;
}

const scrollAfter = 4;

export function Track({ exercise, previous, currentSetIndex, editingSetId, pains, unit, onEdit }: TrackProps) {
  const { colors } = useTheme();
  const count = Math.max(exercise.target.sets, exercise.sets.length + (exercise.entry.status === "pending" ? 1 : 0));
  const previousSets = previous?.sets.filter((set) => !set.interrupted) ?? [];
  const cells = Array.from({ length: count }, (_, index) => {
    const set = exercise.sets[index];
    const level = set === undefined ? null : worstLevel(pains.filter((pain) => pain.strengthSetId === set.id).map((pain) => pain.level));
    const label = (
      <View style={styles.setLabel}>
        <Text style={[styles.setLabelText, { color: index === currentSetIndex && set === undefined ? colors.text : colors.text2 }]}>Série {index + 1}</Text>
        {level === null ? null : <PainMark level={level} />}
      </View>
    );
    if (set !== undefined && set.interrupted) {
      return (
        <View key={index} style={[styles.set, { backgroundColor: colors.surface }]} accessibilityLabel={`Série ${index + 1} interrompue`}>
          {label}
          <Text style={[styles.setWord, { color: colors.text2 }]}>interrompue</Text>
          {set.loadGrams === null ? null : (
            <Text style={styles.setSmall} tone="secondary" numberOfLines={1}>
              {formatMass(set.loadGrams, unit)} {unit}
            </Text>
          )}
        </View>
      );
    }
    if (set !== undefined) {
      const editing = set.id === editingSetId;
      return (
        <Pressable
          key={index}
          accessibilityRole="button"
          accessibilityLabel={`Corriger la série ${index + 1}, ${setText(set, unit)}`}
          accessibilityState={{ selected: editing }}
          onPress={() => onEdit(set)}
          style={({ pressed }) => [
            styles.set,
            { backgroundColor: editing ? colors.surface2 : pressed ? colors.surfacePress : colors.surface },
            editing && { borderWidth: 2, borderColor: colors.text },
          ]}
        >
          {label}
          <Text style={styles.setValue} numberOfLines={1}>
            {setText(set, unit)}
          </Text>
          <Text style={styles.setSmall} tone="secondary">
            RIR {set.rir === null ? "–" : set.rir >= 4 ? "4+" : set.rir}
          </Text>
        </Pressable>
      );
    }
    const current = index === currentSetIndex;
    const last = previousSets[Math.min(index, previousSets.length - 1)];
    const range = rangeText(exercise);
    return (
      <View
        key={index}
        style={[styles.set, { backgroundColor: current ? colors.surface2 : colors.surface }]}
      >
        {current ? <View style={[styles.currentBar, { backgroundColor: colors.mark }]} /> : null}
        {label}
        <Text style={[styles.setWord, current ? null : { color: colors.text3, fontFamily: fonts.text600 }]}>{current ? "en cours" : "à faire"}</Text>
        {last === undefined && range === "" ? null : (
          <Text style={styles.setSmall} tone="secondary" numberOfLines={1}>
            {last === undefined ? `obj. ${range}` : `préc. ${setText(last, unit)}`}
          </Text>
        )}
      </View>
    );
  });

  if (count > scrollAfter) {
    return (
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.trackScroll} contentContainerStyle={styles.trackScrollContent} accessibilityLabel="Séries">
        {cells.map((cell, index) => (
          <View key={index} style={styles.scrollCell}>
            {cell}
          </View>
        ))}
      </ScrollView>
    );
  }
  return (
    <View style={styles.track} accessibilityLabel="Séries">
      {cells.map((cell, index) => (
        <View key={index} style={styles.cell}>
          {cell}
        </View>
      ))}
    </View>
  );
}

interface UpNextProps {
  readonly exercises: readonly WorkoutExercise[];
  readonly fromIndex: number;
  readonly latestPains: ReadonlyMap<ZoneKey, PainReport>;
  readonly onBringForward: (exercise: WorkoutExercise) => void;
}

export function UpNext({ exercises, fromIndex, latestPains, onBringForward }: UpNextProps) {
  const { colors } = useTheme();
  const upcoming = exercises.map((exercise, index) => ({ exercise, index })).filter(({ exercise, index }) => index > fromIndex && exercise.entry.status === "pending");
  if (upcoming.length === 0) return null;
  return (
    <View style={styles.upnext}>
      <View style={[styles.upnextHead, { borderBottomColor: colors.line }]}>
        <Text variant="sectionTitle" tone="secondary" accessibilityRole="header">
          Ensuite
        </Text>
      </View>
      {upcoming.map(({ exercise, index }, offset) => {
        const stopped = stoppedZones(exercise.zones, latestPains);
        return (
          <Pressable
            key={exercise.entry.id}
            accessibilityRole="button"
            accessibilityLabel={`${exercise.exercise.name}, ${targetText(exercise)}`}
            accessibilityHint="Faire cet exercice maintenant"
            onPress={() => onBringForward(exercise)}
            style={({ pressed }) => [styles.upnextRow, { borderBottomColor: colors.line, borderBottomWidth: offset === upcoming.length - 1 ? 0 : 1 }, pressed && { backgroundColor: colors.surface }]}
          >
            <Text style={[styles.upnextIndex, { color: colors.text3 }]}>{index + 1}</Text>
            <View style={styles.upnextMain}>
              <Text style={styles.upnextName}>{exercise.exercise.name}</Text>
              {stopped.length === 0 ? null : (
                <View style={styles.warnLine}>
                  <PainMark level="stop" />
                  <Text variant="caption">{stopped.map(zoneLabel).join(", ")} · arrêt signalé</Text>
                </View>
              )}
            </View>
            <Text style={styles.upnextTarget} tone="secondary">
              {targetText(exercise)}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  progress: { marginTop: 14, flexDirection: "row", alignItems: "center", gap: 10 },
  steps: { flex: 1, flexDirection: "row", alignItems: "center", gap: 3 },
  step: { flex: 1, height: 4, borderRadius: 2 },
  stepNow: { height: 6, borderRadius: 3 },
  stepsLabel: { fontFamily: fonts.figure700, fontSize: 15, lineHeight: 17 },
  track: { marginTop: 16, flexDirection: "row", gap: 2, borderRadius: radii.panel, overflow: "hidden" },
  trackScroll: { marginTop: 16, borderRadius: radii.panel, flexGrow: 0 },
  trackScrollContent: { gap: 2 },
  cell: { flex: 1, minWidth: 0 },
  scrollCell: { width: 96 },
  set: { height: 76, paddingVertical: 10, paddingHorizontal: 12, gap: 5, overflow: "hidden" },
  setLabel: { flexDirection: "row", alignItems: "center", gap: 6 },
  setLabelText: { fontFamily: fonts.text700, fontSize: 12, lineHeight: 12, letterSpacing: 0.48 },
  setValue: { fontFamily: fonts.figure700, fontSize: 21, lineHeight: 21 },
  setWord: { fontFamily: fonts.text700, fontSize: 17, lineHeight: 21 },
  setSmall: { fontFamily: fonts.text400, fontSize: 13, lineHeight: 13 },
  currentBar: { position: "absolute", left: 0, right: 0, bottom: 0, height: 3 },
  upnext: { marginTop: 32 },
  upnextHead: { paddingBottom: 6, borderBottomWidth: 1 },
  upnextRow: { flexDirection: "row", alignItems: "baseline", gap: 8, paddingVertical: 12, minHeight: 48 },
  upnextIndex: { width: 26, fontFamily: fonts.figure700, fontSize: 15, lineHeight: 17 },
  upnextMain: { flex: 1, gap: 4 },
  upnextName: { fontFamily: fonts.text500, fontSize: 16, lineHeight: 21 },
  upnextTarget: { fontFamily: fonts.figure600, fontSize: 16, lineHeight: 18 },
  warnLine: { flexDirection: "row", alignItems: "center", gap: 6 },
});
