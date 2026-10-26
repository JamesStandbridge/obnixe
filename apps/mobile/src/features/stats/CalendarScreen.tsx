import { useMemo, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { router } from "expo-router";
import {
  addDays,
  addMonths,
  calendarMonth,
  checkInDays,
  compareMonths,
  completedSessions,
  currentProgram,
  dateParts,
  dayPain,
  monthEnd,
  monthFacts,
  monthOf,
  monthStart,
  mondayOf,
  nextSlot,
  visibleSessions,
  weighInDays,
} from "@obnixe/core";
import type { CalendarDay, MonthRef, SessionSummary } from "@obnixe/core";
import { settings } from "@obnixe/schema";
import type { LocalDate, SportKey } from "@obnixe/schema";
import { db } from "@/data/database";
import { PainMark } from "@/ui/Controls";
import { Icon } from "@/ui/icons/Icon";
import { SportIcon } from "@/ui/icons/SportIcon";
import { Row, Screen, Section } from "@/ui/Layout";
import { Text } from "@/ui/Text";
import { useTheme } from "@/ui/theme";
import { fonts, radii } from "@/ui/tokens";
import { dayMonth, formatDuration, formatKilograms, levelWords, longDate, monthTitle, sessionsCount, sleepLabel, weekdayLetters } from "@/features/stats/format";
import { capitalize, plural, zoneLabel } from "@/format/labels";
import { sportFilterOptions } from "@/features/stats/JournalScreen";
import type { SportFilter } from "@/features/stats/JournalScreen";
import { useLiveValue, useLocalNow } from "@/features/stats/live";
import { FilterChips, JournalHeader, SmallSportIcon } from "@/features/stats/parts";
import { sportLabel } from "@/features/stats/presentation";
import { remindersSummary, RemindersSheet } from "@/features/stats/RemindersSheet";
import { SessionRow } from "@/features/stats/SessionRow";

function defaultSelection(month: MonthRef, today: LocalDate, sessions: readonly SessionSummary[]): LocalDate {
  if (compareMonths(month, monthOf(today)) === 0) return today;
  const from = monthStart(month);
  const to = monthEnd(month);
  const inMonth = sessions.filter((item) => item.localDate >= from && item.localDate <= to);
  return inMonth[inMonth.length - 1]?.localDate ?? to;
}

export function CalendarScreen() {
  const { colors } = useTheme();
  const { today } = useLocalNow();
  const [month, setMonth] = useState<MonthRef>(() => monthOf(today));
  const [selected, setSelected] = useState<LocalDate>(today);
  const [filter, setFilter] = useState<SportFilter>("all");
  const [remindersOpen, setRemindersOpen] = useState(false);
  const sportFilter: SportKey | null = filter === "all" ? null : filter;

  const data = useLiveValue(
    () => {
      const database = db();
      const range = { from: addDays(monthStart(month), -7), to: addDays(monthEnd(month), 7) };
      const next = nextSlot(database);
      return {
        all: completedSessions(database),
        checkIns: checkInDays(database, range),
        weighIns: weighInDays(database, range),
        sessionsPerWeek: currentProgram(database)?.version.sessionsPerWeek ?? null,
        next: next === null ? null : { sport: next.slot.sport, title: next.variants.length > 0 && next.variants[0] !== undefined ? `${next.slot.name} · ${next.variants[0].name}` : next.slot.name },
        settings: database.select().from(settings).get() ?? null,
      };
    },
    ["session", "session_item", "strength_set", "pain_report", "check_in", "weigh_in", "program", "program_version", "program_slot", "program_variant", "rotation_skip", "settings", "changeset"],
    [month.year, month.month],
  );

  const calendar = useMemo(
    () => calendarMonth({ month, today, sessions: data.all.filter((item) => item.localDate >= addDays(monthStart(month), -7) && item.localDate <= addDays(monthEnd(month), 7)), checkIns: data.checkIns, sessionsPerWeek: data.sessionsPerWeek }),
    [month, today, data.all, data.checkIns, data.sessionsPerWeek],
  );
  const facts = monthFacts(calendar, sportFilter);
  const options = useMemo(() => sportFilterOptions(data.all), [data.all]);
  const firstDate = [data.all[0]?.localDate, data.checkIns[0]?.localDate].filter((value): value is LocalDate => value !== undefined).sort()[0] ?? today;
  const firstMonth = monthOf(firstDate);
  const canGoBack = compareMonths(month, firstMonth) > 0;
  const canGoForward = compareMonths(month, monthOf(today)) < 0;

  const goTo = (offset: number): void => {
    const target = addMonths(month, offset);
    setMonth(target);
    setSelected(defaultSelection(target, today, data.all));
  };

  const rows: (CalendarDay | null)[][] = [];
  calendar.cells.forEach((cell, index) => {
    if (index % 7 === 0) rows.push([]);
    rows[rows.length - 1]?.push(cell);
  });
  const lastRow = rows[rows.length - 1];
  while (lastRow !== undefined && lastRow.length < 7) lastRow.push(null);

  const selectedDay = calendar.cells.find((cell) => cell.date === selected && cell.inMonth) ?? null;
  const settingsRow = data.settings;

  return (
    <>
      <Screen>
        <JournalHeader view="calendar" />
        {options.length > 2 ? (
          <View style={styles.filters}>
            <FilterChips<SportFilter> label="Filtrer par sport" options={options} value={filter} onChange={setFilter} />
          </View>
        ) : null}

        <View style={styles.month}>
          <Text accessibilityRole="header" style={styles.monthTitle}>
            {monthTitle(month.year, month.month)}
          </Text>
          <NavButton icon="back" label="Mois précédent" disabled={!canGoBack} onPress={() => goTo(-1)} />
          <NavButton icon="forward" label="Mois suivant" disabled={!canGoForward} onPress={() => goTo(1)} edge />
        </View>
        <Text style={styles.facts}>
          {sessionsCount(facts.sessions)}
          <Text tone="secondary" style={styles.factsSeparator}>
            {" · "}
          </Text>
          {formatDuration(facts.durationSeconds)}
          <Text tone="secondary" style={styles.factsSeparator}>
            {" · "}
          </Text>
          {`${plural(facts.painDays, "jour")} avec douleur`}
        </Text>

        <View style={styles.weekdays} importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
          {weekdayLetters.map((letter, index) => (
            <Text key={index} tone="tertiary" style={styles.weekday}>
              {letter}
            </Text>
          ))}
        </View>
        <View style={styles.grid} accessibilityLabel="Jours du mois">
          {rows.map((row, rowIndex) => (
            <View key={rowIndex} style={styles.gridRow}>
              {row.map((cell, index) => (cell === null ? <View key={`empty${index}`} style={styles.cellSpacer} /> : <DayCell key={cell.date} day={cell} filter={sportFilter} selected={cell.date === selected} onPress={() => setSelected(cell.date)} />))}
            </View>
          ))}
        </View>
        <Legend />

        {selectedDay === null ? null : (
          <DayDetail day={selectedDay} filter={sportFilter} today={today} next={data.next} weighIn={data.weighIns.find((item) => item.localDate === selectedDay.date)?.grams ?? null} sessions={data.all} />
        )}

        <View style={[styles.reminders, { borderTopColor: colors.line }]}>
          <Row
            title="Rappels dans l'agenda"
            detail={remindersSummary(settingsRow?.reminderWeekdays ?? 0, settingsRow?.reminderMinutes ?? 18 * 60 + 30, settingsRow?.remindersExportedAt ?? null, today)}
            trailing={<Icon name="chevron" size={16} />}
            onPress={() => setRemindersOpen(true)}
            last
          />
        </View>
      </Screen>
      <RemindersSheet open={remindersOpen} mask={settingsRow?.reminderWeekdays ?? 0} minutes={settingsRow?.reminderMinutes ?? 18 * 60 + 30} today={today} onClose={() => setRemindersOpen(false)} />
    </>
  );
}

interface NavButtonProps {
  readonly icon: "back" | "forward";
  readonly label: string;
  readonly disabled: boolean;
  readonly onPress: () => void;
  readonly edge?: boolean;
}

function NavButton({ icon, label, disabled, onPress, edge = false }: NavButtonProps) {
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [styles.nav, edge && styles.navEdge, pressed && { backgroundColor: colors.surface }, disabled && styles.disabled]}
    >
      <Icon name={icon} color={colors.text2} />
    </Pressable>
  );
}

interface DayCellProps {
  readonly day: CalendarDay;
  readonly filter: SportKey | null;
  readonly selected: boolean;
  readonly onPress: () => void;
}

function DayCell({ day, filter, selected, onPress }: DayCellProps) {
  const { colors } = useTheme();
  const { day: number } = dateParts(day.date);
  if (!day.inMonth) {
    return (
      <View style={styles.cell} importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
        <Text tone="tertiary" style={[styles.cellNumber, styles.cellOutside]}>
          {number}
        </Text>
      </View>
    );
  }
  const all = day.sessions;
  const visible = visibleSessions(day, filter);
  const pain = dayPain(day, filter);
  const empty = all.length === 0;
  const ink = selected ? colors.bg : colors.text;
  const parts = [longDate(day.date)];
  if (!empty) parts.push(all.map((item) => sportLabel(item.sport)).join(", "));
  if (empty && day.checkIn !== null) parts.push("check-in seul");
  if (empty && day.checkIn === null && !day.isFuture) parts.push(day.isToday ? "rien de noté" : "repos");
  if (day.planned) parts.push("séance prévue");
  if (pain !== null) parts.push(pain === "stop" ? "arrêt signalé" : "gêne signalée");
  if (day.isToday) parts.push("aujourd'hui");
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={parts.join(", ")}
      accessibilityState={{ selected, disabled: day.isFuture }}
      disabled={day.isFuture}
      onPress={onPress}
      style={[
        styles.cell,
        { backgroundColor: empty ? "transparent" : colors.surface },
        empty && !day.isFuture && { borderWidth: 1, borderColor: colors.line },
        day.isToday && { borderWidth: 2, borderColor: colors.text },
        selected && { backgroundColor: colors.text, borderWidth: 0 },
      ]}
    >
      <Text style={[styles.cellNumber, empty && !selected && styles.cellEmptyNumber, day.isFuture && styles.cellFutureNumber, { color: selected ? colors.bg : day.isFuture ? colors.text3 : empty ? colors.text2 : colors.text }]}>
        {number}
      </Text>
      {pain === null ? null : (
        <View style={styles.cellPain}>
          <PainMark level={pain} />
        </View>
      )}
      {empty && day.checkIn !== null ? <View style={[styles.checkInDot, { backgroundColor: selected ? colors.bg : colors.text2 }]} /> : null}
      {day.planned ? <View style={[styles.plannedMark, { borderColor: colors.controlBorder }]} /> : null}
      <View style={[styles.icons, !empty && visible.length === 0 && styles.dimmed]}>
        {all.slice(0, 2).map((item) => (
          <SmallSportIcon key={item.id} sport={item.sport} color={ink} size={18} />
        ))}
        {all.length > 2 ? <Text style={[styles.more, { color: selected ? colors.bg : colors.text2 }]}>{`+${all.length - 2}`}</Text> : null}
      </View>
    </Pressable>
  );
}

function Legend() {
  const { colors } = useTheme();
  return (
    <View style={styles.legend}>
      <View style={styles.legendItem}>
        <View style={[styles.legendCell, { backgroundColor: colors.surface }]} />
        <Text variant="caption" tone="secondary" style={styles.legendText}>
          séance
        </Text>
      </View>
      <View style={styles.legendItem}>
        <View style={[styles.legendCell, { borderWidth: 1, borderColor: colors.controlBorder }]} />
        <Text variant="caption" tone="secondary" style={styles.legendText}>
          repos
        </Text>
      </View>
      <View style={styles.legendItem}>
        <View style={[styles.legendDot, { backgroundColor: colors.text2 }]} />
        <Text variant="caption" tone="secondary" style={styles.legendText}>
          check-in seul
        </Text>
      </View>
      <View style={styles.legendItem}>
        <PainMark level="discomfort" />
        <Text variant="caption" tone="secondary" style={styles.legendText}>
          gêne
        </Text>
      </View>
      <View style={styles.legendItem}>
        <PainMark level="stop" />
        <Text variant="caption" tone="secondary" style={styles.legendText}>
          arrêt
        </Text>
      </View>
    </View>
  );
}

interface DayDetailProps {
  readonly day: CalendarDay;
  readonly filter: SportKey | null;
  readonly today: LocalDate;
  readonly next: { readonly sport: SportKey; readonly title: string } | null;
  readonly weighIn: number | null;
  readonly sessions: readonly SessionSummary[];
}

function DayDetail({ day, filter, today, next, weighIn, sessions }: DayDetailProps) {
  const { colors } = useTheme();
  const items = visibleSessions(day, filter);
  const hidden = day.sessions.length - items.length;
  const isToday = day.date === today;
  const monday = mondayOf(day.date);
  const week = sessions.filter((item) => item.localDate >= monday && item.localDate <= addDays(monday, 6) && (filter === null || item.sport === filter));
  const weekSeconds = week.reduce((sum, item) => sum + (item.durationSeconds ?? 0), 0);
  const checkIn = day.checkIn;
  return (
    <View style={styles.detail} accessibilityLiveRegion="polite">
      <Section
        title={`${isToday ? "Aujourd'hui, " : ""}${isToday ? longDate(day.date) : capitalize(longDate(day.date))}`}
        action={
          items.length === 0 ? undefined : (
            <Text variant="caption" tone="secondary">
              {sessionsCount(items.length)}
            </Text>
          )
        }
      >
        {items.map((item, index) => (
          <SessionRow key={item.id} summary={item} withDate={false} last={index === items.length - 1} />
        ))}
        {isToday && items.length === 0 && next !== null ? (
          <Row
            leading={<SportIcon sport={next.sport} variant="filled" label={sportLabel(next.sport)} />}
            title={next.title}
            detail="prochaine"
            trailing={<Icon name="chevron" size={16} color={colors.text3} />}
            onPress={() => router.navigate("/")}
            last
          />
        ) : null}
        {!isToday && items.length === 0 ? (
          <Text tone="secondary" style={styles.rest}>
            {hidden > 0 ? `${plural(hidden, "séance masquée", "séances masquées")} par le filtre` : checkIn !== null ? "Pas de séance" : "Repos"}
          </Text>
        ) : null}
        {checkIn === null && !isToday && weighIn === null ? null : (
          <View style={styles.bodyLine}>
            {checkIn !== null ? (
              <View style={styles.bodyItem}>
                <Text variant="small" style={styles.bodyLabel}>
                  Check-in
                </Text>
                <Text variant="small" tone="secondary">
                  {[checkIn.energy === null ? null : `énergie ${checkIn.energy}`, checkIn.sleep === null ? null : `sommeil ${sleepLabel(checkIn.sleep)}`].filter((part): part is string => part !== null).join(" · ")}
                </Text>
                {checkIn.zones.map((zone) => (
                  <View key={zone.zone} style={styles.bodyZone}>
                    <Text variant="small" tone="secondary">
                      ·
                    </Text>
                    {zone.level === "none" ? null : <PainMark level={zone.level} />}
                    <Text variant="small" tone="secondary">{`${zoneLabel(zone.zone).toLowerCase()} ${levelWords[zone.level]}`}</Text>
                  </View>
                ))}
              </View>
            ) : isToday ? (
              <View style={styles.bodyItem}>
                <Text variant="small" style={styles.bodyLabel}>
                  Check-in
                </Text>
                <Text variant="small" tone="secondary">
                  à faire
                </Text>
              </View>
            ) : null}
            {weighIn === null ? null : (
              <View style={styles.bodyItem}>
                <Text variant="small" style={styles.bodyLabel}>
                  Pesée
                </Text>
                <Text variant="small" tone="secondary">{`${formatKilograms(weighIn)} kg`}</Text>
              </View>
            )}
          </View>
        )}
        <Text tone="secondary" style={[styles.weekLine, { borderTopColor: colors.line }]}>
          {`Semaine du ${dayMonth(monday)} · ${sessionsCount(week.length)}${week.length > 0 ? ` · ${formatDuration(weekSeconds)}` : ""}`}
        </Text>
      </Section>
    </View>
  );
}

const styles = StyleSheet.create({
  filters: { marginTop: 12 },
  month: { marginTop: 18, flexDirection: "row", alignItems: "center", gap: 4 },
  monthTitle: { flex: 1, fontFamily: fonts.figure800, fontSize: 30, lineHeight: 32, letterSpacing: -0.3 },
  nav: { width: 44, height: 44, borderRadius: radii.control, alignItems: "center", justifyContent: "center" },
  navEdge: { marginRight: -12 },
  disabled: { opacity: 0.4 },
  facts: { marginTop: 6, fontFamily: fonts.figure700, fontSize: 17, lineHeight: 22 },
  factsSeparator: { fontFamily: fonts.figure600 },
  weekdays: { marginTop: 14, flexDirection: "row", gap: 2 },
  weekday: { flex: 1, textAlign: "center", fontFamily: fonts.text600, fontSize: 12, lineHeight: 12, paddingBottom: 6 },
  grid: { marginTop: 2, gap: 2 },
  gridRow: { flexDirection: "row", gap: 2 },
  cell: { flex: 1, height: 60, borderRadius: radii.control, paddingTop: 5, paddingHorizontal: 4, paddingBottom: 4, alignItems: "center" },
  cellSpacer: { flex: 1, height: 60 },
  cellNumber: { fontFamily: fonts.figure700, fontSize: 15, lineHeight: 15 },
  cellEmptyNumber: { fontFamily: fonts.figure600 },
  cellFutureNumber: { fontFamily: fonts.figure500 },
  cellOutside: { opacity: 0.5, fontFamily: fonts.figure500 },
  cellPain: { position: "absolute", top: 6, right: 5 },
  checkInDot: { position: "absolute", top: 26, left: "50%", marginLeft: -2, width: 4, height: 4, borderRadius: 2 },
  plannedMark: { position: "absolute", bottom: 8, width: 18, height: 4, borderRadius: 2, borderWidth: 1.5 },
  icons: { marginTop: "auto", flexDirection: "row", gap: 1, alignItems: "center", justifyContent: "center" },
  dimmed: { opacity: 0.25 },
  more: { fontFamily: fonts.figure700, fontSize: 12, lineHeight: 20 },
  legend: { marginTop: 10, flexDirection: "row", flexWrap: "wrap", columnGap: 14, rowGap: 6 },
  legendItem: { flexDirection: "row", alignItems: "center", gap: 6 },
  legendText: { fontFamily: fonts.text500 },
  legendCell: { width: 14, height: 14, borderRadius: 4 },
  legendDot: { width: 4, height: 4, borderRadius: 2, marginHorizontal: 5 },
  detail: { marginTop: -6 },
  rest: { paddingTop: 14, paddingBottom: 4 },
  bodyLine: { marginTop: 8, flexDirection: "row", flexWrap: "wrap", columnGap: 14, rowGap: 4 },
  bodyItem: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", columnGap: 4 },
  bodyZone: { flexDirection: "row", alignItems: "center", gap: 4 },
  bodyLabel: { fontFamily: fonts.text600 },
  weekLine: { marginTop: 10, paddingTop: 10, borderTopWidth: 1, fontFamily: fonts.figure700, fontSize: 15, lineHeight: 20 },
  reminders: { marginTop: 22, borderTopWidth: 1 },
});
