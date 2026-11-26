import { useMemo } from "react";
import { StyleSheet, View } from "react-native";
import { workoutReport, workoutTargetTallies } from "@obnixe/core";
import type { ResolvedProfile, WorkRepetitions, WorkoutReport } from "@obnixe/core";
import { rateFigure } from "@/features/recordings/format";
import type { RecordedActivity } from "@/features/recordings/useRecordedActivity";
import { distanceLabel, intentShortLabels, workoutTargetText } from "@/features/workouts/format";
import { formatClock, formatLongClock } from "@/format/durations";
import { formatInteger, formatNumber } from "@/format/numbers";
import { Section } from "@/ui/Layout";
import { Text } from "@/ui/Text";
import { useTheme } from "@/ui/theme";
import { fonts } from "@/ui/tokens";

function spreadText(profile: ResolvedProfile, work: WorkRepetitions): string {
  switch (profile.primary) {
    case "pace": {
      const seconds = (speedMmS: number): number => (profile.pacePerMeters * 1000) / speedMmS;
      return `${formatClock(seconds(work.slowestMmS) - seconds(work.fastestMmS))} ${profile.pacePerMeters === 1000 ? "/km" : "/100 m"}`;
    }
    case "speed":
      return `${formatNumber((work.fastestMmS - work.slowestMmS) * 0.0036)} km/h`;
    default: {
      const unreachable: never = profile.primary;
      return unreachable;
    }
  }
}

interface WorkoutStepsSectionProps {
  readonly activity: RecordedActivity;
}

/** `WKT-007`: one row per step lap, its share of time in the target, and the summary of the work repetitions. */
export function WorkoutStepsSection({ activity }: WorkoutStepsSectionProps) {
  const { colors } = useTheme();
  const { saved, track, profile, processed, zones } = activity;
  const plan = saved.recording.workout;
  const report = useMemo(
    (): WorkoutReport | null => (plan === null ? null : workoutReport(plan, processed.laps, workoutTargetTallies(track, profile, plan, { heartRateZones: zones?.zones ?? null }))),
    [plan, processed.laps, track, profile, zones],
  );
  if (report === null || report.rows.length === 0) return null;
  const { work } = report;
  const workRate = work === null ? null : rateFigure(profile, work.distanceMm, work.movingMs);
  return (
    <Section title="Étapes de la séance">
      <View style={[styles.row, styles.head, { borderBottomColor: colors.line }]}>
        <Text variant="caption" tone="tertiary" style={styles.step}>
          Étape
        </Text>
        <Text variant="caption" tone="tertiary" style={styles.figure}>
          Durée
        </Text>
        <Text variant="caption" tone="tertiary" style={styles.figure}>
          Dist.
        </Text>
        <Text variant="caption" tone="tertiary" style={styles.figure}>
          {profile.primary === "pace" ? "Allure" : "Vit."}
        </Text>
        <Text variant="caption" tone="tertiary" style={styles.small}>
          FC
        </Text>
        <Text variant="caption" tone="tertiary" style={styles.small}>
          Cible
        </Text>
      </View>
      {report.rows.map(({ step, lap, inTargetPermille }, position) => {
        const rate = rateFigure(profile, lap.distanceMm, lap.movingMs);
        const target = step.target.kind === "none" ? null : workoutTargetText(step.target);
        const share = inTargetPermille === null ? "–" : `${formatInteger(inTargetPermille / 10)} %`;
        return (
          <View
            key={step.index}
            style={[styles.row, { borderBottomColor: colors.line, borderBottomWidth: position === report.rows.length - 1 ? 0 : 1 }]}
            accessible
            accessibilityLabel={[
              `${step.index + 1}, ${intentShortLabels[step.intent]}`,
              formatLongClock(lap.elapsedMs / 1000),
              distanceLabel(lap.distanceMm),
              rate === null ? null : `${rate.value} ${rate.unit}`,
              lap.heartRateAvg === null ? null : `${formatInteger(lap.heartRateAvg)} bpm`,
              target === null ? null : `cible ${target}, ${share} dedans`,
            ]
              .filter((part): part is string => part !== null)
              .join(", ")}
          >
            <View style={styles.step}>
              <Text style={[styles.stepName, { color: step.intent === "work" ? colors.text : colors.text2 }]} numberOfLines={1}>
                {`${step.index + 1}. ${intentShortLabels[step.intent]}`}
              </Text>
              {target === null ? null : (
                <Text variant="caption" tone="tertiary" numberOfLines={1}>
                  {target}
                </Text>
              )}
            </View>
            <Text style={[styles.figure, styles.value]}>{formatLongClock(lap.elapsedMs / 1000)}</Text>
            <Text style={[styles.figure, styles.value]}>{distanceLabel(lap.distanceMm)}</Text>
            <Text style={[styles.figure, styles.value]}>{rate === null ? "–" : rate.value}</Text>
            <Text style={[styles.small, styles.value, { color: colors.text2 }]}>{lap.heartRateAvg === null ? "–" : formatInteger(lap.heartRateAvg)}</Text>
            <Text style={[styles.small, styles.value, { color: inTargetPermille !== null && inTargetPermille >= 800 ? colors.mark : colors.text2 }]}>{share}</Text>
          </View>
        );
      })}
      {work === null || workRate === null ? null : (
        <Text variant="small" tone="secondary" style={styles.summary}>
          {`Travail : ${work.count} répétitions, ${distanceLabel(work.distanceMm)} en ${formatLongClock(work.movingMs / 1000)}, moyenne ${workRate.value} ${workRate.unit}, écart ${spreadText(profile, work)} entre la plus rapide et la plus lente`}
        </Text>
      )}
    </Section>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: 6, minHeight: 48, paddingVertical: 6 },
  head: { minHeight: 28, borderBottomWidth: 1 },
  step: { flex: 1, minWidth: 0 },
  stepName: { fontFamily: fonts.text600, fontSize: 14, lineHeight: 18 },
  figure: { width: 54, textAlign: "right" },
  small: { width: 38, textAlign: "right" },
  value: { fontFamily: fonts.figure700, fontSize: 14, fontVariant: ["tabular-nums"] },
  summary: { marginTop: 10 },
});
