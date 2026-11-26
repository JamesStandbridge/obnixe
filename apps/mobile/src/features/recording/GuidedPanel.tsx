import { ScrollView, StyleSheet, View } from "react-native";
import type { ResolvedProfile, SpanBounds, WorkoutRemaining, WorkoutStepRun, WorkoutTargetReading, WorkoutView } from "@obnixe/core";
import { MetricTile } from "@/features/recording/LiveParts";
import type { MetricText } from "@/features/recording/metrics";
import { compactStep, stepTitle, workoutDurationText, workoutTargetText } from "@/features/workouts/format";
import { formatClock, formatLongClock } from "@/format/durations";
import { formatNumber } from "@/format/numbers";
import { Icon } from "@/ui/icons/Icon";
import { Text } from "@/ui/Text";
import { useTheme } from "@/ui/theme";
import type { Palette } from "@/ui/tokens";
import { fonts, radii } from "@/ui/tokens";

/** The share of the gauge on each side of the target span. */
const gaugeMargin = 0.6;
/** The span drawn above an open-ended heart-rate zone, in bpm. */
const openZoneBpm = 20;

function remainingText(remaining: WorkoutRemaining | null, elapsedMs: number): MetricText {
  if (remaining === null) return { value: "—", unit: "" };
  switch (remaining.kind) {
    case "time":
      return { value: formatLongClock(Math.ceil(remaining.ms / 1000)), unit: "" };
    case "distance":
      return remaining.mm < 1_000_000 ? { value: formatNumber(remaining.mm / 1000, 0), unit: "m" } : { value: formatNumber(remaining.mm / 1_000_000, 2), unit: "km" };
    case "open":
      return { value: formatLongClock(elapsedMs / 1000), unit: "" };
    default: {
      const unreachable: never = remaining;
      return unreachable;
    }
  }
}

/** The smoothed value as the target reads: a pace, a speed or a heart rate. */
function readingText(step: WorkoutStepRun, value: number | null): string {
  if (value === null) return "—";
  switch (step.target.kind) {
    case "pace":
      return value <= 0 ? "—" : `${formatClock(1000 / value)} /km`;
    case "speed":
      return `${formatNumber(value * 3.6)} km/h`;
    case "heart_rate":
    case "heart_rate_zone":
      return `${Math.round(value)} bpm`;
    case "none":
      return "—";
    default: {
      const unreachable: never = step.target;
      return unreachable;
    }
  }
}

function positionColor(reading: WorkoutTargetReading, colors: Palette): string {
  switch (reading.position) {
    case null:
      return colors.text3;
    case "inside":
      return colors.mark;
    case "margin":
      return colors.text;
    case "below":
    case "above":
      return colors.warn;
    default: {
      const unreachable: never = reading.position;
      return unreachable;
    }
  }
}

interface GaugeScale {
  readonly low: number;
  readonly high: number;
}

/** The gauge spans the target with a margin on each side; an open zone gets a fixed span above its floor. */
function gaugeScale(bounds: SpanBounds): GaugeScale {
  const high = Number.isFinite(bounds.high) ? bounds.high : bounds.low + openZoneBpm;
  const margin = Math.max(high - bounds.low, 0.05 * high) * gaugeMargin;
  return { low: bounds.low - margin, high: high + margin };
}

function fraction(value: number, scale: GaugeScale): number {
  return Math.min(1, Math.max(0, (value - scale.low) / (scale.high - scale.low)));
}

interface GuidedPanelProps {
  readonly workout: WorkoutView;
  readonly profile: ResolvedProfile;
}

/** `WKT-004`: the step, its rank, what remains of it, the target gauge and the next step. */
export function GuidedPanel({ workout, profile }: GuidedPanelProps) {
  const { colors } = useTheme();
  const { current, next, target } = workout;
  if (current === null) {
    return (
      <View style={styles.done} accessible accessibilityLiveRegion="polite">
        <Icon name="check" size={28} color={colors.mark} />
        <Text variant="heading">Séance terminée</Text>
        <Text variant="small" tone="secondary">
          Continue librement ou termine la sortie.
        </Text>
      </View>
    );
  }
  const remaining = remainingText(workout.remaining, workout.stepElapsedMs);
  const rank = `${current.index + 1}/${workout.steps.length}`;
  return (
    <View style={styles.panel}>
      <View style={styles.head} accessible accessibilityLiveRegion="polite" accessibilityLabel={`Étape ${rank}, ${stepTitle(current)}`}>
        <View style={[styles.intent, { backgroundColor: current.intent === "work" ? colors.sport[profile.sport] : colors.text3 }]} />
        <Text variant="heading" numberOfLines={1} style={styles.title}>
          {stepTitle(current)}
        </Text>
        {current.repetition === null ? null : (
          <Text variant="caption" tone="secondary">
            {`Rép. ${current.repetition.number}/${current.repetition.count}`}
          </Text>
        )}
        <Text style={[styles.rank, { color: colors.text2 }]}>{rank}</Text>
      </View>
      <MetricTile caption={workout.remaining?.kind === "open" ? "Écoulé · étape libre" : "Restant"} text={remaining} scale="guided" accent={colors.sport[profile.sport]} style={styles.remaining} />
      {target === null || current.target.kind === "none" ? null : <TargetGauge step={current} reading={target} />}
      <Text variant="small" tone="secondary" numberOfLines={1} style={styles.next}>
        {next === null ? "Dernière étape" : `Ensuite : ${stepTitle(next)} · ${compactStep(next)}`}
      </Text>
    </View>
  );
}

interface TargetGaugeProps {
  readonly step: WorkoutStepRun;
  readonly reading: WorkoutTargetReading;
}

function TargetGauge({ step, reading }: TargetGaugeProps) {
  const { colors } = useTheme();
  const label = step.target.kind === "none" ? "" : workoutTargetText(step.target);
  const current = readingText(step, reading.value);
  const scale = reading.bounds === null ? null : gaugeScale(reading.bounds);
  const color = positionColor(reading, colors);
  return (
    <View style={styles.gauge} accessible accessibilityLabel={`Cible ${label}, actuel ${current}`}>
      <View style={styles.gaugeHead}>
        <Text variant="caption" tone="secondary">{`Cible ${label}`}</Text>
        <Text style={[styles.reading, { color }]}>{current}</Text>
      </View>
      {scale === null || reading.bounds === null ? (
        <Text variant="caption" tone="tertiary">
          Zones de FC inconnues : renseigne ta FC max.
        </Text>
      ) : (
        <View style={[styles.track, { backgroundColor: colors.surface2 }]}>
          <View
            style={[
              styles.zone,
              {
                backgroundColor: colors.mark,
                left: `${fraction(reading.bounds.low, scale) * 100}%`,
                width: `${(fraction(Number.isFinite(reading.bounds.high) ? reading.bounds.high : scale.high, scale) - fraction(reading.bounds.low, scale)) * 100}%`,
              },
            ]}
          />
          {reading.value === null ? null : <View style={[styles.marker, { backgroundColor: colors.text, left: `${fraction(reading.value, scale) * 100}%` }]} />}
        </View>
      )}
    </View>
  );
}

interface StepsPageProps {
  readonly workout: WorkoutView;
}

/** The unfolded plan, the finished steps dimmed and the current one marked. */
export function StepsPage({ workout }: StepsPageProps) {
  const { colors } = useTheme();
  const currentIndex = workout.current?.index ?? workout.steps.length;
  return (
    <ScrollView contentContainerStyle={styles.steps}>
      {workout.steps.map((step) => {
        const state = step.index < currentIndex ? "done" : step.index === currentIndex ? "current" : "upcoming";
        const detail = step.target.kind === "none" ? workoutDurationText(step.duration) : `${workoutDurationText(step.duration)} · ${workoutTargetText(step.target)}`;
        return (
          <View
            key={step.index}
            style={[styles.stepRow, { borderBottomColor: colors.line }, state === "current" && { backgroundColor: colors.surface, borderLeftColor: colors.mark }, state === "done" && styles.stepDone]}
            accessible
            accessibilityLabel={`${step.index + 1}, ${stepTitle(step)}, ${detail}${state === "done" ? ", faite" : state === "current" ? ", en cours" : ""}`}
          >
            <Text style={[styles.stepIndex, { color: colors.text2 }]}>{step.index + 1}</Text>
            <View style={styles.stepText}>
              <Text variant="bodyStrong" numberOfLines={1}>
                {stepTitle(step)}
              </Text>
              <Text variant="small" tone="secondary" numberOfLines={1}>
                {detail}
              </Text>
            </View>
            {step.repetition === null ? null : (
              <Text variant="caption" tone="secondary">
                {`${step.repetition.number}/${step.repetition.count}`}
              </Text>
            )}
            {state === "done" ? <Icon name="check" size={18} color={colors.text3} /> : null}
          </View>
        );
      })}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  panel: { flex: 1, paddingTop: 12, gap: 8 },
  head: { flexDirection: "row", alignItems: "center", gap: 8 },
  intent: { width: 4, height: 22, borderRadius: 2 },
  title: { flex: 1, minWidth: 0 },
  rank: { fontFamily: fonts.figure700, fontSize: 18 },
  remaining: { flex: 1, minHeight: 130, justifyContent: "center" },
  gauge: { gap: 6 },
  gaugeHead: { flexDirection: "row", justifyContent: "space-between", alignItems: "baseline" },
  reading: { fontFamily: fonts.figure700, fontSize: 22 },
  track: { height: 14, borderRadius: 7, overflow: "hidden" },
  zone: { position: "absolute", top: 0, bottom: 0, opacity: 0.55 },
  marker: { position: "absolute", top: 0, bottom: 0, width: 4, marginLeft: -2, borderRadius: 2 },
  next: { paddingBottom: 10 },
  done: { flex: 1, alignItems: "center", justifyContent: "center", gap: 6, paddingVertical: 24 },
  steps: { paddingTop: 10, paddingBottom: 24 },
  stepRow: { flexDirection: "row", alignItems: "center", gap: 10, minHeight: 56, paddingVertical: 8, paddingHorizontal: 8, borderBottomWidth: 1, borderLeftWidth: 4, borderLeftColor: "transparent", borderRadius: radii.control },
  stepDone: { opacity: 0.55 },
  stepIndex: { width: 28, fontFamily: fonts.figure700, fontSize: 16 },
  stepText: { flex: 1, minWidth: 0, gap: 2 },
});
