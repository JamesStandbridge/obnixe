import { StyleSheet, View } from "react-native";
import { dateParts, weekdayIndex } from "@obnixe/core";
import type { WeekDay, WeekSummary } from "@obnixe/core";
import type { SportKey } from "@obnixe/schema";
import { LinkButton } from "@/ui/Button";
import { StatRow } from "@/ui/Stats";
import type { StatValue } from "@/ui/Stats";
import { Text } from "@/ui/Text";
import { useTheme } from "@/ui/theme";
import { fonts, layout, radii } from "@/ui/tokens";
import { durationFigure, longDate, weekRange, weekdayLetters } from "@/features/stats/format";
import { sportLabel } from "@/features/stats/presentation";
import { formatInteger } from "@/format/numbers";

const markHeight = 30;
const maxStacked = 3;

function stateWords(day: WeekDay): string {
  switch (day.state) {
    case "done":
      return `${day.sports.length > 1 ? "séances faites" : "séance faite"} : ${day.sports.map((sport) => sportLabel(sport).toLowerCase()).join(", ")}`;
    case "planned":
      return "séance prévue";
    case "rest":
      return "repos";
    default: {
      const unreachable: never = day.state;
      return unreachable;
    }
  }
}

interface SportCount {
  readonly sport: SportKey;
  readonly count: number;
}

function sportCounts(days: readonly WeekDay[]): SportCount[] {
  const counts = new Map<SportKey, number>();
  for (const sport of days.flatMap((day) => day.sports)) counts.set(sport, (counts.get(sport) ?? 0) + 1);
  return [...counts.entries()].map(([sport, count]) => ({ sport, count })).sort((left, right) => right.count - left.count);
}

function weekStats(week: WeekSummary): StatValue[] {
  const time = durationFigure(week.durationSeconds);
  const sessions: StatValue = {
    label: "Séances",
    value: formatInteger(week.sessionsDone),
    unit: week.sessionsPlanned === null ? "" : `/ ${formatInteger(week.sessionsPlanned)}`,
  };
  const duration: StatValue = { label: "Temps", value: week.durationSeconds === 0 ? "0" : time.value, unit: week.durationSeconds === 0 ? "min" : time.unit };
  if (week.sessionsPlanned === null) return [sessions, duration];
  const remaining = Math.max(0, week.sessionsPlanned - week.sessionsDone);
  return [sessions, duration, { label: "À faire", value: formatInteger(remaining), unit: "" }];
}

interface WeekHeroProps {
  readonly week: WeekSummary;
  readonly onJournal: () => void;
}

export function WeekHero({ week, onJournal }: WeekHeroProps) {
  const { colors } = useTheme();
  const counts = sportCounts(week.days);
  return (
    <View style={styles.hero}>
      <View style={styles.head}>
        <View style={styles.headText}>
          <Text variant="eyebrow" accessibilityRole="header">
            Cette semaine
          </Text>
          <Text variant="caption" tone="tertiary" style={styles.range}>
            {weekRange(week.monday)}
          </Text>
        </View>
        <LinkButton label="Journal" onPress={onJournal} style={styles.link} />
      </View>
      <StatRow stats={weekStats(week)} size="large" style={styles.stats} />
      <WeekStrip days={week.days} />
      {counts.length === 0 ? null : (
        <View style={styles.legend}>
          {counts.map((item) => (
            <View key={item.sport} style={styles.legendItem} accessible accessibilityLabel={`${sportLabel(item.sport)} : ${item.count}`}>
              <View style={[styles.swatch, { backgroundColor: colors.sport[item.sport] }]} />
              <Text variant="caption" tone="secondary">
                {sportLabel(item.sport)}
              </Text>
              <Text style={styles.legendCount}>{formatInteger(item.count)}</Text>
            </View>
          ))}
        </View>
      )}
    </View>
  );
}

interface WeekStripProps {
  readonly days: readonly WeekDay[];
}

function WeekStrip({ days }: WeekStripProps) {
  const { colors } = useTheme();
  return (
    <View style={styles.week}>
      {days.map((day) => (
        <View
          key={day.date}
          accessible
          accessibilityLabel={`${longDate(day.date)}, ${stateWords(day)}${day.isToday ? ", aujourd'hui" : ""}`}
          style={[styles.day, day.isToday && { backgroundColor: colors.surface }]}
        >
          <Text tone={day.isToday ? "primary" : "tertiary"} style={styles.letter}>
            {weekdayLetters[weekdayIndex(day.date)]}
          </Text>
          <Text style={[styles.date, day.isToday && { color: colors.mark }]}>{dateParts(day.date).day}</Text>
          <DayMark day={day} />
        </View>
      ))}
    </View>
  );
}

function DayMark({ day }: { readonly day: WeekDay }) {
  const { colors } = useTheme();
  switch (day.state) {
    case "done":
      return (
        <View style={styles.mark}>
          {day.sports.slice(0, maxStacked).map((sport, index) => (
            <View key={`${sport}-${index}`} style={[styles.segment, { backgroundColor: colors.sport[sport] }]} />
          ))}
        </View>
      );
    case "planned":
      return <View style={[styles.mark, styles.planned, { borderColor: day.isToday ? colors.mark : colors.controlBorder }]} />;
    case "rest":
      return (
        <View style={styles.mark}>
          <View style={[styles.rest, { backgroundColor: colors.surface2 }]} />
        </View>
      );
    default: {
      const unreachable: never = day.state;
      return unreachable;
    }
  }
}

const styles = StyleSheet.create({
  hero: { marginTop: 14 },
  head: { flexDirection: "row", alignItems: "center", gap: 12, minHeight: 44 },
  headText: { flex: 1, flexDirection: "row", alignItems: "baseline", gap: 8 },
  range: { fontFamily: fonts.text500 },
  link: { marginRight: -10 },
  stats: { marginTop: 4 },
  week: { flexDirection: "row", gap: 4, marginTop: 16 },
  day: { flex: 1, alignItems: "center", gap: 5, paddingTop: 8, paddingBottom: 8, paddingHorizontal: 4, borderRadius: radii.control },
  letter: { fontFamily: fonts.text700, fontSize: 11, lineHeight: 12, letterSpacing: 0.6 },
  date: { fontFamily: fonts.figure700, fontSize: 18, lineHeight: 19 },
  mark: { width: 14, height: markHeight, marginTop: 2, gap: 2, justifyContent: "flex-end" },
  segment: { flex: 1, borderRadius: 4 },
  planned: { borderWidth: layout.borderControl, borderRadius: 4 },
  rest: { height: 4, borderRadius: 2 },
  legend: { flexDirection: "row", flexWrap: "wrap", columnGap: 16, rowGap: 6, marginTop: 12 },
  legendItem: { flexDirection: "row", alignItems: "center", gap: 6 },
  swatch: { width: 8, height: 8, borderRadius: 2 },
  legendCount: { fontFamily: fonts.figure700, fontSize: 15, lineHeight: 16 },
});
