import { useMemo, useState } from "react";
import { FlatList, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { completedSessions, currentProgram, dateParts, mondayOf, regularity } from "@obnixe/core";
import type { RegularityWeek, SessionSummary } from "@obnixe/core";
import { exerciseNameKey, sports } from "@obnixe/schema";
import type { LocalDate, SportKey } from "@obnixe/schema";
import { db } from "@/data/database";
import { IconButton, TextField } from "@/ui/Inputs";
import { Text } from "@/ui/Text";
import { useTheme } from "@/ui/theme";
import { fonts, layout } from "@/ui/tokens";
import { formatDuration, sessionsCount, weekRange } from "@/features/stats/format";
import { formatNumber } from "@/format/numbers";
import { monthShort } from "@/format/dates";
import { useLiveValue, useLocalNow } from "@/features/stats/live";
import { FilterChips, JournalHeader } from "@/features/stats/parts";
import type { ChipOption } from "@/features/stats/parts";
import { sportLabel } from "@/features/stats/presentation";
import { sessionTitle } from "@/format/labels";
import { ActivityCard } from "@/features/stats/ActivityCard";
import { useMassUnit } from "@/data/settings";

export type SportFilter = SportKey | "all";

export function sportFilterOptions(sessions: readonly Pick<SessionSummary, "sport">[]): ChipOption<SportFilter>[] {
  const counts = new Map<SportKey, number>();
  for (const item of sessions) counts.set(item.sport, (counts.get(item.sport) ?? 0) + 1);
  const ordered = [...counts.entries()].sort((left, right) => right[1] - left[1]).map(([sport]) => sport);
  return [{ value: "all", label: "Tout" }, ...ordered.map((sport) => ({ value: sport, label: sportLabel(sport), sport }))];
}

interface SportTime {
  readonly sport: SportKey;
  readonly seconds: number;
}

interface WeekGroup {
  readonly monday: LocalDate;
  readonly sessions: readonly SessionSummary[];
  readonly durationSeconds: number;
  readonly sportTimes: readonly SportTime[];
}

function sportTimes(sessions: readonly SessionSummary[]): SportTime[] {
  const seconds = new Map<SportKey, number>();
  for (const item of sessions) if (item.durationSeconds !== null && item.durationSeconds > 0) seconds.set(item.sport, (seconds.get(item.sport) ?? 0) + item.durationSeconds);
  return [...seconds.entries()].map(([sport, total]) => ({ sport, seconds: total })).sort((left, right) => right.seconds - left.seconds);
}

function groupByWeek(sessions: readonly SessionSummary[]): WeekGroup[] {
  const groups = new Map<LocalDate, SessionSummary[]>();
  for (const item of [...sessions].reverse()) {
    const monday = mondayOf(item.localDate);
    const list = groups.get(monday);
    if (list === undefined) groups.set(monday, [item]);
    else list.push(item);
  }
  return [...groups.entries()].map(([monday, items]) => ({ monday, sessions: items, durationSeconds: items.reduce((sum, item) => sum + (item.durationSeconds ?? 0), 0), sportTimes: sportTimes(items) }));
}

function matchesQuery(item: SessionSummary, query: string): boolean {
  if (query === "") return true;
  const haystack = exerciseNameKey([sessionTitle(item), sports[item.sport].label, item.note ?? ""].join(" "));
  return haystack.includes(query);
}

function weekLabel(week: RegularityWeek, previous: RegularityWeek | undefined): string {
  const { day, month } = dateParts(week.monday);
  if (previous === undefined || dateParts(previous.monday).month !== month) return `${day} ${monthShort[month - 1]}`;
  return String(day);
}

interface WeekHeaderProps {
  readonly week: WeekGroup;
  readonly current: boolean;
}

function WeekHeader({ week, current }: WeekHeaderProps) {
  const { colors } = useTheme();
  const title = current ? "Cette semaine" : weekRange(week.monday);
  const totals = `${sessionsCount(week.sessions.length)}${week.durationSeconds > 0 ? ` · ${formatDuration(week.durationSeconds)}` : ""}`;
  const split = week.sportTimes.map((item) => `${sportLabel(item.sport)} ${formatDuration(item.seconds)}`).join(", ");
  return (
    <View style={styles.weekHead} accessible accessibilityRole="header" accessibilityLabel={`${title}, ${totals}${split === "" ? "" : `, ${split}`}`}>
      <View style={styles.weekTitleLine}>
        <Text variant="sectionTitle">{title}</Text>
        <Text variant="caption" tone="secondary">
          {totals}
        </Text>
      </View>
      {week.sportTimes.length === 0 ? null : (
        <>
          <View style={styles.weekBar}>
            {week.sportTimes.map((item) => (
              <View key={item.sport} style={[styles.weekBarPart, { flex: item.seconds, backgroundColor: colors.sport[item.sport] }]} />
            ))}
          </View>
          <View style={styles.weekLegend}>
            {week.sportTimes.map((item) => (
              <View key={item.sport} style={styles.weekLegendItem}>
                <View style={[styles.weekLegendDot, { backgroundColor: colors.sport[item.sport] }]} />
                <Text variant="caption" tone="secondary">
                  {`${sportLabel(item.sport)} ${formatDuration(item.seconds)}`}
                </Text>
              </View>
            ))}
          </View>
        </>
      )}
    </View>
  );
}

export function JournalScreen() {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const { today } = useLocalNow();
  const massUnit = useMassUnit();
  const [filter, setFilter] = useState<SportFilter>("all");
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState("");
  const data = useLiveValue(
    () => ({ sessions: completedSessions(db()), sessionsPerWeek: currentProgram(db())?.version.sessionsPerWeek ?? null }),
    ["session", "session_item", "strength_set", "pain_report", "program", "program_version", "program_slot", "program_variant", "changeset"],
    [],
  );
  const options = useMemo(() => sportFilterOptions(data.sessions), [data.sessions]);
  const normalizedQuery = exerciseNameKey(query);
  const visible = useMemo(
    () => data.sessions.filter((item) => (filter === "all" || item.sport === filter) && matchesQuery(item, normalizedQuery)),
    [data.sessions, filter, normalizedQuery],
  );
  const weeks = useMemo(() => groupByWeek(visible), [visible]);
  const regular = useMemo(() => regularity(today, visible, 8, filter === "all" ? data.sessionsPerWeek : null), [today, visible, filter, data.sessionsPerWeek]);
  const currentMonday = mondayOf(today);
  const maxStack = Math.max(1, ...regular.weeks.map((week) => week.done + week.planned));
  const unit = Math.min(10, (92 - 3 * (maxStack - 1)) / maxStack);

  const header = (
    <View>
      <JournalHeader view="list" trailing={<IconButton icon="search" label="Rechercher" edge="end" pressed={searching} onPress={() => (searching ? (setSearching(false), setQuery("")) : setSearching(true))} />} />
      {searching ? <TextField value={query} onChangeText={setQuery} placeholder="Titre, sport, note" autoFocus accessibilityLabel="Rechercher dans le journal" style={styles.search} /> : null}
      {options.length > 2 ? (
        <View style={styles.filters}>
          <FilterChips<SportFilter> label="Filtrer par sport" options={options} value={filter} onChange={setFilter} />
        </View>
      ) : null}
      {data.sessions.length === 0 ? null : (
        <View style={styles.regularity} accessible accessibilityLabel={`Régularité sur 8 semaines : ${formatNumber(regular.averagePerWeek)} séances par semaine`}>
          <View style={styles.regularityHead}>
            <Text style={styles.regularityFigure}>
              {formatNumber(regular.averagePerWeek)}
              <Text tone="secondary" style={styles.regularityUnit}>
                {"  séances par semaine"}
              </Text>
            </Text>
            <Text variant="caption" tone="secondary">
              8 dernières semaines
            </Text>
          </View>
          <View style={styles.weeks}>
            {regular.weeks.map((week, index) => (
              <View key={week.monday} style={styles.weekColumn}>
                <View style={styles.stack}>
                  {week.sports.map((sport, item) => (
                    <View key={`d${item}`} style={[styles.stackItem, { height: unit, backgroundColor: colors.sport[sport] }]} />
                  ))}
                  {Array.from({ length: week.planned }, (_, item) => (
                    <View key={`p${item}`} style={[styles.stackItem, { height: unit, borderWidth: layout.borderControl, borderColor: colors.controlBorder }]} />
                  ))}
                </View>
                <View style={[styles.weekAxis, { backgroundColor: week.isCurrent ? colors.mark : colors.line }]} />
                <Text tone={week.isCurrent ? "primary" : "secondary"} style={week.isCurrent ? styles.weekLabelCurrent : styles.weekLabel}>
                  {weekLabel(week, regular.weeks[index - 1])}
                </Text>
              </View>
            ))}
          </View>
        </View>
      )}
    </View>
  );

  return (
    <FlatList
      style={{ backgroundColor: colors.bg }}
      contentContainerStyle={{ paddingTop: insets.top + 14, paddingHorizontal: layout.gutter, paddingBottom: insets.bottom + 32 }}
      data={weeks}
      keyExtractor={(week) => week.monday}
      ListHeaderComponent={header}
      initialNumToRender={4}
      windowSize={7}
      ListEmptyComponent={
        <View style={styles.empty}>
          <Text variant="bodyStrong">{data.sessions.length === 0 ? "Pas encore de séance" : "Aucune séance"}</Text>
          <Text variant="small" tone="secondary">
            {data.sessions.length === 0 ? "Les séances notées apparaîtront ici, semaine par semaine." : "Rien ne correspond à ce filtre."}
          </Text>
        </View>
      }
      renderItem={({ item }) => (
        <View style={styles.week}>
          <WeekHeader week={item} current={item.monday === currentMonday} />
          {item.sessions.map((summary) => (
            <ActivityCard key={summary.id} summary={summary} massUnit={massUnit} />
          ))}
        </View>
      )}
    />
  );
}

const styles = StyleSheet.create({
  search: { marginTop: 12 },
  filters: { marginTop: 12 },
  regularity: { marginTop: 20, gap: 10 },
  regularityHead: { flexDirection: "row", alignItems: "baseline", justifyContent: "space-between" },
  regularityFigure: { fontFamily: fonts.figure800, fontSize: 34, lineHeight: 36, letterSpacing: -0.3 },
  regularityUnit: { fontFamily: fonts.text600, fontSize: 15, letterSpacing: 0 },
  weeks: { flexDirection: "row", gap: 6, alignItems: "flex-end", height: 104 },
  weekColumn: { flex: 1, alignItems: "center", gap: 6 },
  stack: { flexDirection: "column-reverse", gap: 3, width: "100%", maxWidth: 28 },
  stackItem: { borderRadius: 2 },
  weekAxis: { height: 2, width: "100%", maxWidth: 28, borderRadius: 1 },
  weekLabel: { fontFamily: fonts.figure600, fontSize: 12, lineHeight: 12 },
  weekLabelCurrent: { fontFamily: fonts.figure700, fontSize: 12, lineHeight: 12 },
  empty: { marginTop: 28, gap: 6 },
  week: { marginTop: 28, gap: 8 },
  weekHead: { gap: 8, marginBottom: 4 },
  weekTitleLine: { flexDirection: "row", alignItems: "baseline", justifyContent: "space-between", gap: 12 },
  weekBar: { flexDirection: "row", height: 4, gap: 2 },
  weekBarPart: { borderRadius: 1 },
  weekLegend: { flexDirection: "row", flexWrap: "wrap", columnGap: 14, rowGap: 4 },
  weekLegendItem: { flexDirection: "row", alignItems: "center", gap: 6 },
  weekLegendDot: { width: 8, height: 8, borderRadius: 2 },
});
