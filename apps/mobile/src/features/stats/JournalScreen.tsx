import { useMemo, useState } from "react";
import { FlatList, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { completedSessions, currentProgram, dateParts, mondayOf, orderSessions, regularity } from "@obnixe/core";
import type { JournalOrder, RegularityWeek, SessionSummary } from "@obnixe/core";
import { exerciseNameKey, sports } from "@obnixe/schema";
import type { FieldDefinition, LocalDate, SportKey } from "@obnixe/schema";
import { db } from "@/data/database";
import { EmptyScene } from "@/ui/illustrations/scenes";
import { IconButton, TextField } from "@/ui/Inputs";
import { Slash } from "@/ui/Shapes";
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
import { summaryTitle } from "@/format/labels";
import { ActivityCard } from "@/features/stats/ActivityCard";
import { useMassUnit } from "@/data/settings";

export type SportFilter = SportKey | "all";

export function sportFilterOptions(sessions: readonly Pick<SessionSummary, "sport">[]): ChipOption<SportFilter>[] {
  const counts = new Map<SportKey, number>();
  for (const item of sessions) counts.set(item.sport, (counts.get(item.sport) ?? 0) + 1);
  const ordered = [...counts.entries()].sort((left, right) => right[1] - left[1]).map(([sport]) => sport);
  return [{ value: "all", label: "Tout" }, ...ordered.map((sport) => ({ value: sport, label: sportLabel(sport), sport }))];
}

const allVariants = "";

/** `SUM-012`: the `kind` options of the chosen sport that some session has. */
export function variantFilterOptions(sport: SportFilter, sessions: readonly Pick<SessionSummary, "sport" | "values">[]): ChipOption<string>[] {
  if (sport === "all") return [];
  const fields: readonly FieldDefinition[] = sports[sport].sessionFields;
  const field = fields.find((candidate) => candidate.key === "kind");
  if (field === undefined || field.type !== "choice") return [];
  const used = new Set(sessions.filter((item) => item.sport === sport).map((item) => item.values.kind));
  const options = field.options.filter((option) => used.has(option.key)).map((option) => ({ value: option.key, label: option.label }));
  return options.length < 2 ? [] : [{ value: allVariants, label: "Toutes" }, ...options];
}

const orderOptions: readonly ChipOption<JournalOrder>[] = [
  { value: "date", label: "Date" },
  { value: "distance", label: "Distance" },
  { value: "duration", label: "Durée" },
  { value: "ascent", label: "D+" },
];

type JournalItem = { readonly kind: "week"; readonly week: WeekGroup } | { readonly kind: "session"; readonly summary: SessionSummary };

function itemKey(item: JournalItem): string {
  switch (item.kind) {
    case "week":
      return item.week.monday;
    case "session":
      return item.summary.id;
    default: {
      const unreachable: never = item;
      return unreachable;
    }
  }
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
  const haystack = exerciseNameKey([summaryTitle(item), sports[item.sport].label, item.note ?? ""].join(" "));
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
        <View style={styles.weekTitle}>
          <Slash color={colors.mark} width={10} height={14} />
          <Text variant="heading">{title}</Text>
        </View>
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
  const [variant, setVariant] = useState<string>(allVariants);
  const [order, setOrder] = useState<JournalOrder>("date");
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState("");
  const data = useLiveValue(
    () => ({ sessions: completedSessions(db()), sessionsPerWeek: currentProgram(db())?.version.sessionsPerWeek ?? null }),
    ["session", "session_item", "strength_set", "pain_report", "program", "program_version", "program_slot", "program_variant", "changeset", "recording"],
    [],
  );
  const options = useMemo(() => sportFilterOptions(data.sessions), [data.sessions]);
  const variants = useMemo(() => variantFilterOptions(filter, data.sessions), [filter, data.sessions]);
  const chosenVariant = variants.some((option) => option.value === variant) ? variant : allVariants;
  const normalizedQuery = exerciseNameKey(query);
  const visible = useMemo(
    () =>
      data.sessions.filter(
        (item) => (filter === "all" || item.sport === filter) && (chosenVariant === allVariants || item.values.kind === chosenVariant) && matchesQuery(item, normalizedQuery),
      ),
    [data.sessions, filter, chosenVariant, normalizedQuery],
  );
  const items = useMemo(
    (): readonly JournalItem[] =>
      order === "date" ? groupByWeek(visible).map((week) => ({ kind: "week", week })) : orderSessions(visible, order).map((summary) => ({ kind: "session", summary })),
    [visible, order],
  );
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
      {variants.length === 0 ? null : (
        <View style={styles.filters}>
          <FilterChips<string> label="Filtrer par variante" options={variants} value={chosenVariant} onChange={setVariant} />
        </View>
      )}
      {data.sessions.length === 0 ? null : (
        <View style={styles.filters}>
          <FilterChips<JournalOrder> label="Trier" options={orderOptions} value={order} onChange={setOrder} />
        </View>
      )}
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
      data={items}
      keyExtractor={itemKey}
      ListHeaderComponent={header}
      initialNumToRender={4}
      windowSize={7}
      ListEmptyComponent={
        <View style={styles.empty}>
          {data.sessions.length === 0 ? (
            <View style={styles.emptyArt}>
              <EmptyScene kind="journal" size={176} />
            </View>
          ) : null}
          <Text variant="heading">{data.sessions.length === 0 ? "Pas encore de séance" : "Aucune séance"}</Text>
          <Text variant="small" tone="secondary">
            {data.sessions.length === 0 ? "Les séances notées apparaîtront ici, semaine par semaine." : "Rien ne correspond à ce filtre."}
          </Text>
        </View>
      }
      renderItem={({ item }) => {
        switch (item.kind) {
          case "week":
            return (
              <View style={styles.week}>
                <WeekHeader week={item.week} current={item.week.monday === currentMonday} />
                {item.week.sessions.map((summary) => (
                  <ActivityCard key={summary.id} summary={summary} massUnit={massUnit} />
                ))}
              </View>
            );
          case "session":
            return (
              <View style={styles.ranked}>
                <ActivityCard summary={item.summary} massUnit={massUnit} />
              </View>
            );
          default: {
            const unreachable: never = item;
            return unreachable;
          }
        }
      }}
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
  stackItem: { borderRadius: 2, transform: [{ skewX: "-12deg" }] },
  weekAxis: { height: 2, width: "100%", maxWidth: 28, borderRadius: 1 },
  weekLabel: { fontFamily: fonts.figure600, fontSize: 12, lineHeight: 12 },
  weekLabelCurrent: { fontFamily: fonts.figure700, fontSize: 12, lineHeight: 12 },
  empty: { marginTop: 28, gap: 6 },
  emptyArt: { alignItems: "center", marginBottom: 10 },
  weekTitle: { flexDirection: "row", alignItems: "center", gap: 8, flexShrink: 1 },
  week: { marginTop: 28, gap: 8 },
  ranked: { marginTop: 8 },
  weekHead: { gap: 8, marginBottom: 4 },
  weekTitleLine: { flexDirection: "row", alignItems: "baseline", justifyContent: "space-between", gap: 12 },
  weekBar: { flexDirection: "row", height: 5, gap: 3 },
  weekBarPart: { borderRadius: 1, transform: [{ skewX: "-24deg" }] },
  weekLegend: { flexDirection: "row", flexWrap: "wrap", columnGap: 14, rowGap: 4 },
  weekLegendItem: { flexDirection: "row", alignItems: "center", gap: 6 },
  weekLegendDot: { width: 8, height: 8, borderRadius: 2 },
});
