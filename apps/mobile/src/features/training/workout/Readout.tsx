import { useEffect, useRef } from "react";
import { Animated, Pressable, StyleSheet, View } from "react-native";
import { impactAsync, ImpactFeedbackStyle } from "expo-haptics";
import { durationStepSeconds, gramsToMass } from "@obnixe/core";
import type { WorkoutExercise } from "@obnixe/core";
import type { MassUnit } from "@obnixe/schema";
import { equipmentLabels, formatMass } from "@/features/training/format";
import { formatClock } from "@/format/durations";
import { formatNumber } from "@/format/numbers";
import { durationLimit, loadLimits, rangeText, repsLimit } from "@/features/training/workout/liveWorkout";
import type { Comparison, Draft } from "@/features/training/workout/liveWorkout";
import { PainMark } from "@/ui/Controls";
import { Scale } from "@/ui/Inputs";
import type { ScaleOption } from "@/ui/Inputs";
import { usePressScale } from "@/ui/motion";
import { Text } from "@/ui/Text";
import { useTheme } from "@/ui/theme";
import { fonts, layout, radii } from "@/ui/tokens";

export type DraftKey = "load" | "reps" | "duration";

const rirOptions: readonly ScaleOption<number>[] = [
  { value: 0, label: "0", caption: "échec" },
  { value: 1, label: "1" },
  { value: 2, label: "2" },
  { value: 3, label: "3" },
  { value: 4, label: "4+", caption: "facile" },
];

interface ReadoutProps {
  readonly target: WorkoutExercise;
  readonly draft: Draft;
  readonly suggested: boolean;
  readonly unit: MassUnit;
  readonly stepGrams: number;
  readonly comparison: Comparison;
  readonly onAdjust: (key: DraftKey, direction: 1 | -1) => boolean;
  readonly onOpenPad: (key: DraftKey) => void;
  readonly onRir: (rir: number | null) => void;
}

export function Readout({ target, draft, suggested, unit, stepGrams, comparison, onAdjust, onOpenPad, onRir }: ReadoutProps) {
  const measure = target.exercise.measure;
  const equipment = equipmentLabels[target.exercise.equipment];
  const range = rangeText(target);
  const loadValue = gramsToMass(draft.loadGrams ?? 0, unit);
  const loadMax = loadLimits[unit];
  const stepLabel = formatMass(stepGrams, unit);
  const step = gramsToMass(stepGrams, unit);
  const reps = draft.reps ?? 0;
  const duration = draft.durationSeconds ?? 0;
  const targetRir = target.target.rir === null ? undefined : Math.min(4, target.target.rir);

  return (
    <View style={styles.readout}>
      {measure === "duration" ? (
        <View style={styles.figureRow}>
          <Figure text={formatClock(duration)} unit="durée" range={range === "" ? null : `${range} s`} suggested={suggested} label="Saisir la durée" onPress={() => onOpenPad("duration")} />
        </View>
      ) : measure === "bodyweight_reps" ? (
        <View style={styles.figureRow}>
          <Figure text={String(reps)} unit="rép." range={range === "" ? null : range} suggested={suggested} label="Saisir les répétitions" onPress={() => onOpenPad("reps")} />
        </View>
      ) : (
        <View style={styles.figureRow}>
          <Figure text={formatNumber(loadValue)} unit={`${unit} · ${equipment}`} range={null} suggested={suggested} label="Saisir la charge" onPress={() => onOpenPad("load")} />
          <TimesSign />
          <Figure text={String(reps)} unit="rép." range={range === "" ? null : range} suggested={suggested} label="Saisir les répétitions" onPress={() => onOpenPad("reps")} />
        </View>
      )}

      <View style={styles.comparison}>
        {comparison.mark === null ? null : (
          <View style={styles.comparisonMark}>
            <PainMark level={comparison.mark} />
          </View>
        )}
        <Text numberOfLines={1} style={styles.comparisonText} tone="secondary">
          <Text style={styles.comparisonLead}>{comparison.lead}</Text>
          {comparison.previous === null ? "" : ` · ${comparison.previous}`}
        </Text>
      </View>

      <View style={styles.adjust}>
        {measure === "load_reps" ? (
          <View style={styles.adjustGroup}>
            <AdjustButton label={`−${stepLabel}`} accessibilityLabel={`Retirer ${stepLabel} ${unit}`} disabled={loadValue - step < 0} onStep={() => onAdjust("load", -1)} />
            <AdjustButton label={`+${stepLabel}`} accessibilityLabel={`Ajouter ${stepLabel} ${unit}`} disabled={loadValue + step > loadMax} onStep={() => onAdjust("load", 1)} />
          </View>
        ) : null}
        {measure === "duration" ? (
          <View style={styles.adjustGroup}>
            <AdjustButton label={`−${durationStepSeconds} s`} accessibilityLabel={`Retirer ${durationStepSeconds} secondes`} disabled={duration - durationStepSeconds < 0} onStep={() => onAdjust("duration", -1)} />
            <AdjustButton label={`+${durationStepSeconds} s`} accessibilityLabel={`Ajouter ${durationStepSeconds} secondes`} disabled={duration + durationStepSeconds > durationLimit} onStep={() => onAdjust("duration", 1)} />
          </View>
        ) : (
          <View style={styles.adjustGroup}>
            <AdjustButton label="−1" accessibilityLabel="Retirer 1 répétition" disabled={reps - 1 < 0} onStep={() => onAdjust("reps", -1)} />
            <AdjustButton label="+1" accessibilityLabel="Ajouter 1 répétition" disabled={reps + 1 > repsLimit} onStep={() => onAdjust("reps", 1)} />
          </View>
        )}
      </View>

      <View style={styles.rir}>
        <Text variant="sectionTitle" tone="secondary">
          Réserve (RIR)
        </Text>
        <Scale
          label="Répétitions en réserve, de 0 (échec) à 4 et plus (facile)"
          options={rirOptions}
          value={draft.rir === null ? null : Math.min(4, draft.rir)}
          onChange={onRir}
          optional
          {...(targetRir === undefined ? {} : { target: targetRir })}
        />
      </View>
    </View>
  );
}

function TimesSign() {
  const { colors } = useTheme();
  return (
    <Text accessible={false} importantForAccessibility="no" style={[styles.times, { color: colors.text3 }]}>
      ×
    </Text>
  );
}

interface FigureProps {
  readonly text: string;
  readonly unit: string;
  readonly range: string | null;
  readonly suggested: boolean;
  readonly label: string;
  readonly onPress: () => void;
}

function Figure({ text, unit, range, suggested, label, onPress }: FigureProps) {
  const { colors } = useTheme();
  const [integer = "", decimal] = text.split(",");
  const compact = integer.replace(/\D/g, "").length >= 3 || text.includes(":");
  const tone = suggested ? colors.text3 : colors.text;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${label}, ${text} ${unit}${range === null ? "" : `, objectif ${range}`}`}
      accessibilityHint={suggested ? "Valeur suggérée" : undefined}
      onPress={onPress}
      style={({ pressed }) => [styles.figure, pressed && { backgroundColor: colors.surface }]}
    >
      <View style={styles.figureValue}>
        <Text style={[styles.figureText, compact && styles.figureCompact, { color: tone }]} numberOfLines={1} maxFontSizeMultiplier={1}>
          {integer}
        </Text>
        {decimal === undefined ? null : (
          <Text style={[styles.figureDecimal, compact && styles.figureDecimalCompact, { color: tone }]} maxFontSizeMultiplier={1}>
            ,{decimal}
          </Text>
        )}
      </View>
      <Text style={styles.figureUnit} tone="secondary" numberOfLines={1} maxFontSizeMultiplier={1.3}>
        {unit.toUpperCase()}
        {range === null ? null : (
          <>
            {" · OBJ. "}
            <Text style={[styles.figureUnit, styles.figureRange]}>{range}</Text>
          </>
        )}
      </Text>
    </Pressable>
  );
}

interface AdjustButtonProps {
  readonly label: string;
  readonly accessibilityLabel: string;
  readonly disabled: boolean;
  readonly onStep: () => boolean;
}

const holdDelayMs = 420;
const repeatSlowMs = 160;
const repeatFastMs = 60;
const accelerateAfterMs = 1400;

function AdjustButton({ label, accessibilityLabel, disabled, onStep }: AdjustButtonProps) {
  const { colors } = useTheme();
  const press = usePressScale(0.96);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const holdStartedAt = useRef(0);
  const lastPressInAt = useRef(0);
  const stepRef = useRef(onStep);
  stepRef.current = onStep;

  const stop = (): void => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  };
  useEffect(() => stop, []);

  const step = (): boolean => {
    const moved = stepRef.current();
    if (moved) void impactAsync(ImpactFeedbackStyle.Light);
    return moved;
  };
  const repeat = (): void => {
    if (!step()) return;
    timer.current = setTimeout(repeat, Date.now() - holdStartedAt.current > accelerateAfterMs ? repeatFastMs : repeatSlowMs);
  };

  return (
    <Animated.View style={[styles.adjustCell, { transform: [{ scale: press.scale }] }, disabled && styles.disabled]}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
        accessibilityState={{ disabled }}
        disabled={disabled}
        onPressIn={() => {
          press.onPressIn();
          lastPressInAt.current = Date.now();
          holdStartedAt.current = Date.now();
          step();
          timer.current = setTimeout(repeat, holdDelayMs);
        }}
        onPressOut={() => {
          press.onPressOut();
          stop();
        }}
        onPress={() => {
          if (Date.now() - lastPressInAt.current < 600) return;
          step();
        }}
        style={({ pressed }) => [styles.adjustButton, { backgroundColor: pressed ? colors.surfacePress : colors.surface, borderColor: colors.controlBorder }]}
      >
        <Text style={styles.adjustLabel} maxFontSizeMultiplier={1.2}>
          {label}
        </Text>
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  readout: { marginTop: 20, gap: 16 },
  figureRow: { flexDirection: "row", alignItems: "flex-end", justifyContent: "center" },
  figure: { flex: 1, alignItems: "center", gap: 6, paddingTop: 6, paddingBottom: 8, borderRadius: radii.panel },
  figureValue: { flexDirection: "row", alignItems: "flex-start" },
  figureText: { fontFamily: fonts.figure800, fontSize: 100, lineHeight: 92, letterSpacing: -2.5, includeFontPadding: false },
  figureCompact: { fontSize: 86, lineHeight: 80 },
  figureDecimal: { fontFamily: fonts.figure700, fontSize: 55, lineHeight: 55, marginLeft: 1, marginTop: 4 },
  figureDecimalCompact: { fontSize: 47, lineHeight: 47 },
  figureUnit: { fontFamily: fonts.text600, fontSize: 13, lineHeight: 15, letterSpacing: 0.52 },
  figureRange: { fontFamily: fonts.text700 },
  times: { width: 28, textAlign: "center", fontFamily: fonts.figure600, fontSize: 36, lineHeight: 38, paddingBottom: 30 },
  comparison: { flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 4 },
  comparisonMark: { paddingTop: 1 },
  comparisonText: { flex: 1, fontFamily: fonts.text400, fontSize: 14, lineHeight: 19 },
  comparisonLead: { fontFamily: fonts.text700, fontSize: 15, lineHeight: 19 },
  adjust: { flexDirection: "row", gap: 10 },
  adjustGroup: { flex: 1, flexDirection: "row", gap: 6 },
  adjustCell: { flex: 1 },
  adjustButton: { height: 64, borderRadius: radii.control, borderWidth: layout.borderControl, alignItems: "center", justifyContent: "center" },
  adjustLabel: { fontFamily: fonts.figure700, fontSize: 22, lineHeight: 24 },
  disabled: { opacity: 0.4 },
  rir: { gap: 8 },
});
