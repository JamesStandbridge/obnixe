import { Pressable, StyleSheet, View } from "react-native";
import { router } from "expo-router";
import { worstLevel } from "@obnixe/core";
import type { ExerciseReport, SessionReport } from "@obnixe/core";
import type { LocalDate, MassUnit, StrengthSet } from "@obnixe/schema";
import { formatMass, loadContext } from "@/features/training/format";
import { formatClock } from "@/format/durations";
import { outcomeText } from "@/features/training/sessionText";
import { bestSetIndex, setScores } from "@/features/training/detail/sessionStats";
import type { SetTarget } from "@/features/training/detail/SetSheet";
import { setText, targetText } from "@/features/training/workout/liveWorkout";
import { PainMark } from "@/ui/Controls";
import { Icon } from "@/ui/icons/Icon";
import { Text } from "@/ui/Text";
import { useTheme } from "@/ui/theme";
import { fonts, radii } from "@/ui/tokens";

function exerciseDetail(report: ExerciseReport, today: LocalDate, unit: MassUnit): string {
  const { outcome, exercise } = report;
  const plan = exercise.item === null ? "hors programme" : `prévu ${targetText(exercise)}${exercise.target.rir === null ? "" : ` · RIR ${exercise.target.rir}`}`;
  switch (outcome.kind) {
    case "stopped":
      return `arrêté · ${outcome.setsDone} ${outcome.setsDone > 1 ? "séries" : "série"}${outcome.setsPlanned === null ? "" : ` sur ${outcome.setsPlanned}`}`;
    case "skipped":
      return "passé";
    case "suspended":
      return "progression suspendue";
    case "same":
    case "reps":
    case "duration":
      return outcomeText(outcome, exercise.exercise.loadMode, today, unit, false);
    case "load":
    case "first":
      return plan;
    default: {
      const unreachable: never = outcome;
      return unreachable;
    }
  }
}

interface SetFigure {
  readonly main: string;
  readonly unit: string;
  readonly reps: string;
}

function setFigure(set: StrengthSet, unit: MassUnit): SetFigure {
  const loaded = set.loadGrams !== null && set.loadGrams > 0;
  if (set.interrupted) return set.loadGrams === null ? { main: "–", unit: "", reps: "" } : { main: formatMass(set.loadGrams, unit), unit, reps: "" };
  if (loaded && set.durationSeconds === null) return { main: formatMass(set.loadGrams ?? 0, unit), unit, reps: ` × ${set.reps ?? 0}` };
  return { main: setText(set, unit), unit: "", reps: "" };
}

interface ExerciseBlockProps {
  readonly report: SessionReport;
  readonly exercise: ExerciseReport;
  readonly today: LocalDate;
  readonly unit: MassUnit;
  readonly onSet: (target: SetTarget) => void;
}

export function ExerciseBlock({ report, exercise, today, unit, onSet }: ExerciseBlockProps) {
  const { colors } = useTheme();
  const tone = colors.sport.strength;
  const target = exercise.exercise;
  const name = target.exercise.name;
  const context = loadContext(target.exercise, unit);
  const best = bestSetIndex(target.sets, target.exercise);
  const scores = setScores(target.sets, target.exercise);
  const top = Math.max(1, ...scores);
  const showRir = target.sets.some((set) => set.rir !== null);
  const showRest = target.sets.some((set) => set.restBeforeSeconds !== null);
  return (
    <View style={[styles.block, { backgroundColor: colors.surface }]}>
      <View style={styles.head}>
        <View style={styles.headMain}>
          <Pressable
            accessibilityRole="link"
            accessibilityLabel={`${name}, voir la progression`}
            onPress={() => router.push({ pathname: "/journal/progress", params: { exercise: target.exercise.id } })}
            style={styles.link}
          >
            <Text style={styles.name} numberOfLines={1}>
              {name}
            </Text>
            <Icon name="chevron" size={14} color={colors.text3} />
          </Pressable>
          <Text variant="small" tone="secondary" numberOfLines={1}>
            {context === null ? exerciseDetail(exercise, today, unit) : `${exerciseDetail(exercise, today, unit)} · ${context}`}
          </Text>
        </View>
        {target.sets.length < 2 ? null : (
          <View style={styles.bars} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
            {scores.map((score, index) => (
              <View
                key={target.sets[index]?.id ?? index}
                style={[styles.bar, { height: 3 + (score / top) * 21, backgroundColor: index === best ? tone : score === 0 ? colors.surface2 : colors.text3 }]}
              />
            ))}
          </View>
        )}
      </View>
      {target.sets.length === 0 ? null : (
        <View style={[styles.columns, { borderBottomColor: colors.line }]} accessible={false} importantForAccessibility="no-hide-descendants">
          <Text variant="caption" tone="tertiary" style={styles.colIndex}>
            Série
          </Text>
          <Text variant="caption" tone="tertiary" style={styles.colValue}>
            Charge × rép.
          </Text>
          {showRir ? (
            <Text variant="caption" tone="tertiary" style={styles.colRir}>
              RIR
            </Text>
          ) : null}
          {showRest ? (
            <Text variant="caption" tone="tertiary" style={styles.colRest}>
              Repos
            </Text>
          ) : null}
        </View>
      )}
      {target.sets.map((set, index) => {
        const level = worstLevel(report.data.pains.filter((pain) => pain.strengthSetId === set.id).map((pain) => pain.level));
        const rest = set.restBeforeSeconds === null ? "–" : formatClock(set.restBeforeSeconds);
        const figure = setFigure(set, unit);
        const value = `${figure.main}${figure.unit === "" ? "" : ` ${figure.unit}`}${figure.reps}`;
        const isBest = index === best;
        return (
          <Pressable
            key={set.id}
            accessibilityRole="button"
            accessibilityLabel={`Série ${index + 1}, ${set.interrupted ? "interrompue" : `${value}, RIR ${set.rir ?? "non noté"}`}${isBest ? ", meilleure série" : ""}, repos ${set.restBeforeSeconds === null ? (index === 0 ? "aucun" : "non mesuré") : rest}`}
            accessibilityHint="Corriger la série"
            onPress={() => onSet({ exercise: target, set, index })}
            style={({ pressed }) => [styles.set, pressed && { backgroundColor: colors.surfacePress }]}
          >
            {isBest ? <View style={[styles.bestMark, { backgroundColor: tone }]} /> : null}
            <View style={[styles.colIndex, styles.index]}>
              <Text style={[styles.indexText, { color: isBest ? tone : colors.text3 }]}>{index + 1}</Text>
              {level === null ? null : <PainMark level={level} />}
            </View>
            <Text style={[styles.colValue, styles.value, { color: set.interrupted ? colors.text3 : isBest ? tone : colors.text }]} numberOfLines={1}>
              {figure.main}
              {figure.unit === "" ? null : <Text style={[styles.valueUnit, { color: isBest ? tone : colors.text2 }]}>{` ${figure.unit}`}</Text>}
              {figure.reps}
            </Text>
            {showRir ? (
              <Text style={[styles.colRir, styles.small]} tone="secondary">
                {set.interrupted ? "arrêt" : set.rir === null ? "–" : set.rir >= 4 ? "4+" : String(set.rir)}
              </Text>
            ) : null}
            {showRest ? (
              <Text style={[styles.colRest, styles.small]} tone="secondary">
                {rest}
              </Text>
            ) : null}
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  block: { marginTop: 10, borderRadius: radii.panel, overflow: "hidden", paddingBottom: 6 },
  head: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 14, paddingTop: 6, paddingBottom: 10 },
  headMain: { flex: 1, minWidth: 0 },
  link: { flexDirection: "row", alignItems: "center", gap: 4, minHeight: 44, alignSelf: "flex-start", maxWidth: "100%" },
  name: { fontFamily: fonts.text700, fontSize: 17, flexShrink: 1 },
  bars: { flexDirection: "row", alignItems: "flex-end", gap: 2, height: 24 },
  bar: { width: 5, borderRadius: 1 },
  columns: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 14, paddingBottom: 6, borderBottomWidth: 1 },
  colIndex: { width: 40 },
  colValue: { flex: 1, minWidth: 0 },
  colRir: { width: 36, textAlign: "right" },
  colRest: { width: 48, textAlign: "right" },
  set: { flexDirection: "row", alignItems: "center", gap: 12, minHeight: 44, paddingHorizontal: 14 },
  bestMark: { position: "absolute", left: 0, top: 8, bottom: 8, width: 3, borderTopRightRadius: 2, borderBottomRightRadius: 2 },
  index: { flexDirection: "row", alignItems: "center", gap: 6 },
  indexText: { fontFamily: fonts.figure700, fontSize: 16, lineHeight: 18 },
  value: { fontFamily: fonts.figure700, fontSize: 21, lineHeight: 24 },
  valueUnit: { fontFamily: fonts.figure600, fontSize: 14 },
  small: { fontFamily: fonts.figure600, fontSize: 16, lineHeight: 18 },
});
