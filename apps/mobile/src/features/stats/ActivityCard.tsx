import { Pressable, StyleSheet, View } from "react-native";
import { climbBreakdown, gramsToMass, indicatorOver, parseGrade } from "@obnixe/core";
import type { SessionSummary, StrengthDigest, StrengthDigestExercise } from "@obnixe/core";
import { efforts, sports } from "@obnixe/schema";
import type { Effort, FieldValues, MassUnit, SportDefinition } from "@obnixe/schema";
import { SportIcon } from "@/ui/icons/SportIcon";
import { StatRow } from "@/ui/Stats";
import type { StatValue } from "@/ui/Stats";
import { Text } from "@/ui/Text";
import { useTheme } from "@/ui/theme";
import { fonts, radii, wash } from "@/ui/tokens";
import { formatTimeAt } from "@/format/dates";
import { formatClock } from "@/format/durations";
import { capitalize, plural, sessionTitle, zoneLabel } from "@/format/labels";
import { formatInteger, formatNumber } from "@/format/numbers";
import { durationFigure, effortLabel, painWords, rowDate } from "@/features/stats/format";
import { DetailLine } from "@/features/stats/parts";
import { distanceFigure, formatRatio, itemNoun, sportLabel } from "@/features/stats/presentation";
import { openSession, sessionFlagParts } from "@/features/stats/SessionRow";
import { formatMass } from "@/features/training/format";

const shownExercises = 3;
const shownClimbs = 14;

function durationStat(summary: SessionSummary): StatValue | null {
  return summary.durationSeconds === null ? null : { label: "Durée", ...durationFigure(summary.durationSeconds) };
}

function continuousStats(sport: SportDefinition, summary: SessionSummary): StatValue[] {
  const stats: StatValue[] = [];
  const distance = summary.values.distance;
  if (typeof distance === "number") stats.push({ label: "Distance", ...distanceFigure(sport, distance) });
  for (const indicator of sport.indicators) {
    if (indicator.type !== "ratio") continue;
    const value = indicatorOver(indicator, sport, [summary]);
    if (value?.kind === "number") stats.push({ label: indicator.label, ...formatRatio(indicator, value.value) });
  }
  const gain = summary.values.elevation_gain;
  if (typeof gain === "number" && gain > 0) stats.push({ label: "D+", value: formatInteger(gain), unit: "m" });
  const duration = durationStat(summary);
  if (duration !== null && stats.length < 3) stats.push(duration);
  const heartRate = summary.values.heart_rate_avg;
  if (typeof heartRate === "number" && stats.length < 3) stats.push({ label: "FC moyenne", value: formatInteger(heartRate), unit: "bpm" });
  return stats.slice(0, 3);
}

function volumeFigure(grams: number, unit: MassUnit): Omit<StatValue, "label"> {
  if (unit === "kg" && grams >= 1_000_000) return { value: formatNumber(grams / 1_000_000, 1), unit: "t" };
  return { value: formatInteger(gramsToMass(grams, unit)), unit };
}

function strengthStats(summary: SessionSummary, unit: MassUnit): StatValue[] {
  const stats: StatValue[] = [];
  const duration = durationStat(summary);
  if (duration !== null) stats.push(duration);
  if (summary.strength !== null) {
    stats.push({ label: "Séries", value: formatInteger(summary.strength.sets), unit: "" });
    if (summary.strength.volumeGrams > 0) stats.push({ label: "Volume", ...volumeFigure(summary.strength.volumeGrams, unit) });
  }
  return stats;
}

function climbStats(summary: SessionSummary): StatValue[] {
  const breakdown = climbBreakdown(summary.items.map((values) => ({ values })));
  if (breakdown.count === 0) {
    const duration = durationStat(summary);
    return duration === null ? [] : [duration];
  }
  const stats: StatValue[] = [{ label: capitalize(`${itemNoun(summary.sport, summary.values)}s`), value: formatInteger(breakdown.count), unit: "" }];
  if (breakdown.maxSent !== null) stats.push({ label: "Max enchaîné", value: breakdown.maxSent, unit: "" });
  stats.push({ label: "Flash", value: formatInteger(breakdown.flash), unit: "" });
  return stats;
}

function cardStats(summary: SessionSummary, unit: MassUnit): StatValue[] {
  const sport: SportDefinition = sports[summary.sport];
  switch (sport.archetype) {
    case "continuous":
      return continuousStats(sport, summary);
    case "strength":
      return strengthStats(summary, unit);
    case "itemized":
      return climbStats(summary);
    default: {
      const unreachable: never = sport.archetype;
      return unreachable;
    }
  }
}

function setsText(item: StrengthDigestExercise, unit: MassUnit): string {
  const effort = item.topReps !== null ? formatInteger(item.topReps) : item.topDurationSeconds !== null ? (item.topDurationSeconds < 60 ? `${item.topDurationSeconds} s` : formatClock(item.topDurationSeconds)) : null;
  const sets = effort === null ? plural(item.sets, "série") : `${formatInteger(item.sets)} × ${effort}`;
  return item.topLoadGrams === null || item.topLoadGrams === 0 ? sets : `${sets} · ${formatMass(item.topLoadGrams, unit)} ${unit}`;
}

interface StrengthSignatureProps {
  readonly digest: StrengthDigest;
  readonly unit: MassUnit;
  readonly tone: string;
}

function StrengthSignature({ digest, unit, tone }: StrengthSignatureProps) {
  const { colors } = useTheme();
  const byVolume = digest.volumeGrams > 0;
  const weight = (item: StrengthDigestExercise): number => (byVolume ? item.volumeGrams : item.sets);
  const ranked = [...digest.exercises].sort((left, right) => weight(right) - weight(left));
  const top = ranked.slice(0, shownExercises);
  const max = Math.max(1, ...top.map(weight));
  const hidden = digest.exercises.length - top.length;
  return (
    <View style={styles.exercises}>
      {top.map((item, index) => (
        <View key={`${item.name}-${index}`} style={styles.exercise}>
          <View style={styles.exerciseLine}>
            <Text variant="small" tone="secondary" numberOfLines={1} style={styles.exerciseName}>
              {item.name}
            </Text>
            <Text style={styles.exerciseFigure} numberOfLines={1}>
              {setsText(item, unit)}
            </Text>
          </View>
          <View style={[styles.track, { backgroundColor: wash(colors.text, 0.1) }]}>
            <View style={[styles.fill, { width: `${Math.max(4, (weight(item) / max) * 100)}%`, backgroundColor: tone }]} />
          </View>
        </View>
      ))}
      {hidden > 0 ? (
        <Text variant="caption" tone="tertiary">
          {`+ ${plural(hidden, "autre exercice", "autres exercices")}`}
        </Text>
      ) : null}
    </View>
  );
}

type ClimbResult = "flash" | "sent" | "project";

function climbResult(values: FieldValues): ClimbResult {
  return values.result === "flash" ? "flash" : values.result === "sent" ? "sent" : "project";
}

function resultRank(result: ClimbResult): number {
  switch (result) {
    case "flash":
      return 2;
    case "sent":
      return 1;
    case "project":
      return 0;
    default: {
      const unreachable: never = result;
      return unreachable;
    }
  }
}

interface ClimbChip {
  readonly label: string;
  readonly rank: number;
  readonly result: ClimbResult;
}

function climbChips(items: readonly FieldValues[]): ClimbChip[] {
  return items
    .map((values) => {
      const grade = parseGrade(values.grade);
      return { label: grade?.label ?? "?", rank: grade?.index ?? -1, result: climbResult(values) };
    })
    .sort((left, right) => right.rank - left.rank || resultRank(right.result) - resultRank(left.result));
}

interface ClimbSignatureProps {
  readonly items: readonly FieldValues[];
  readonly tone: string;
}

function ClimbSignature({ items, tone }: ClimbSignatureProps) {
  const { colors } = useTheme();
  const chips = climbChips(items);
  const hidden = chips.length - shownClimbs;
  return (
    <View style={styles.chips}>
      {chips.slice(0, shownClimbs).map((chip, index) => {
        const filled = chip.result === "flash";
        const sent = chip.result === "sent";
        return (
          <View
            key={index}
            style={[
              styles.chip,
              filled ? { backgroundColor: tone } : sent ? { backgroundColor: wash(tone, 0.22) } : { borderWidth: 1, borderColor: colors.controlBorder, borderStyle: "dashed" },
            ]}
          >
            <Text style={[styles.chipLabel, { color: filled ? colors.bg : sent ? colors.text : colors.text3 }]}>{chip.label}</Text>
          </View>
        );
      })}
      {hidden > 0 ? (
        <Text variant="caption" tone="tertiary" style={styles.chipMore}>
          {`+${hidden}`}
        </Text>
      ) : null}
    </View>
  );
}

function effortLevel(effort: Effort): number {
  return efforts.indexOf(effort) + 1;
}

interface EffortMeterProps {
  readonly effort: Effort;
  readonly tone: string;
}

function EffortMeter({ effort, tone }: EffortMeterProps) {
  const { colors } = useTheme();
  const level = effortLevel(effort);
  return (
    <View style={styles.effort}>
      <Text variant="caption" tone="secondary">
        Effort
      </Text>
      <View style={styles.effortSegments}>
        {efforts.map((step, index) => (
          <View key={step} style={[styles.effortSegment, { backgroundColor: index < level ? tone : wash(colors.text, 0.1) }]} />
        ))}
      </View>
      <Text variant="caption">{capitalize(effortLabel(effort))}</Text>
    </View>
  );
}

function cardDate(summary: SessionSummary): string {
  return `${rowDate(summary.localDate)} · ${formatTimeAt(summary.startedAt, summary.timeZone)}`;
}

function cardLabel(summary: SessionSummary, stats: readonly StatValue[]): string {
  const parts = [`${sportLabel(summary.sport)}, ${sessionTitle(summary)}`, cardDate(summary)];
  for (const stat of stats) parts.push(`${stat.label} ${stat.value} ${stat.unit}`.trim());
  if (summary.effort !== null) parts.push(`effort ${effortLabel(summary.effort)}`);
  for (const pain of summary.pains) parts.push(`${painWords[pain.level]} ${zoneLabel(pain.zone).toLowerCase()}`);
  if (summary.addedBy !== null) parts.push(`ajoutée par ${summary.addedBy}`);
  return parts.join(", ");
}

interface ActivityCardProps {
  readonly summary: SessionSummary;
  readonly massUnit: MassUnit;
}

export function ActivityCard({ summary, massUnit }: ActivityCardProps) {
  const { colors } = useTheme();
  const tone = colors.sport[summary.sport];
  const archetype = sports[summary.sport].archetype;
  const stats = cardStats(summary, massUnit);
  const flags = sessionFlagParts(summary);
  const date = archetype !== "continuous" && summary.effort !== null ? `${cardDate(summary)} · ${effortLabel(summary.effort)}` : cardDate(summary);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={cardLabel(summary, stats)}
      onPress={() => openSession(summary.id)}
      style={({ pressed }) => [styles.card, { backgroundColor: pressed ? colors.surface2 : colors.surface }]}
    >
      <View style={styles.head}>
        <SportIcon sport={summary.sport} variant="badge" />
        <View style={styles.headText}>
          <Text variant="bodyStrong" numberOfLines={1}>
            {sessionTitle(summary)}
          </Text>
          <Text variant="caption" tone="secondary" numberOfLines={1}>
            {date}
          </Text>
        </View>
      </View>
      {stats.length === 0 ? null : <StatRow stats={stats} />}
      {archetype === "strength" && summary.strength !== null ? <StrengthSignature digest={summary.strength} unit={massUnit} tone={tone} /> : null}
      {archetype === "itemized" && summary.items.length > 0 ? <ClimbSignature items={summary.items} tone={tone} /> : null}
      {archetype === "continuous" && summary.effort !== null ? <EffortMeter effort={summary.effort} tone={tone} /> : null}
      {flags.length === 0 ? null : <DetailLine parts={flags} />}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: { borderRadius: radii.panel, padding: 14, gap: 14 },
  head: { flexDirection: "row", alignItems: "center", gap: 12 },
  headText: { flex: 1, minWidth: 0, gap: 2 },
  exercises: { gap: 8 },
  exercise: { gap: 4 },
  exerciseLine: { flexDirection: "row", alignItems: "baseline", gap: 12 },
  exerciseName: { flex: 1, minWidth: 0 },
  exerciseFigure: { fontFamily: fonts.figure700, fontSize: 15, lineHeight: 18 },
  track: { height: 3, borderRadius: 1.5, overflow: "hidden" },
  fill: { height: 3, borderRadius: 1.5 },
  chips: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 4 },
  chip: { minWidth: 34, height: 24, paddingHorizontal: 6, borderRadius: radii.tag, alignItems: "center", justifyContent: "center" },
  chipLabel: { fontFamily: fonts.figure700, fontSize: 14, lineHeight: 16 },
  chipMore: { marginLeft: 4 },
  effort: { flexDirection: "row", alignItems: "center", gap: 10 },
  effortSegments: { flex: 1, flexDirection: "row", gap: 3 },
  effortSegment: { flex: 1, height: 4, borderRadius: 1 },
});
