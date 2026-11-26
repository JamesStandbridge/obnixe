import { useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { router } from "expo-router";
import { completedSessions, dateParts, periodTotals } from "@obnixe/core";
import type { PeriodTotal, TotalsPeriod } from "@obnixe/core";
import type { LocalDate, SportKey } from "@obnixe/schema";
import { db } from "@/data/database";
import { distanceText, elapsedText } from "@/features/recordings/format";
import { useLiveValue } from "@/features/stats/live";
import { monthLong, monthShort, shortDate } from "@/format/dates";
import { plural } from "@/format/labels";
import { formatInteger } from "@/format/numbers";
import { LinkButton } from "@/ui/Button";
import { Segmented } from "@/ui/Controls";
import { Section } from "@/ui/Layout";
import { StatRow } from "@/ui/Stats";
import { Text } from "@/ui/Text";
import { useTheme } from "@/ui/theme";
import { fonts, wash } from "@/ui/tokens";

const periodOptions: readonly { readonly value: TotalsPeriod; readonly label: string }[] = [
  { value: "week", label: "Semaine" },
  { value: "month", label: "Mois" },
  { value: "year", label: "Année" },
];

const barsHeight = 72;

function periodCount(period: TotalsPeriod): number {
  switch (period) {
    case "week":
      return 8;
    case "month":
      return 12;
    case "year":
      return 4;
    default: {
      const unreachable: never = period;
      return unreachable;
    }
  }
}

function barLabel(total: PeriodTotal, period: TotalsPeriod): string {
  const { year, month, day } = dateParts(total.from);
  switch (period) {
    case "week":
      return String(day);
    case "month":
      return (monthShort[month - 1] ?? "").slice(0, 1).toUpperCase();
    case "year":
      return String(year);
    default: {
      const unreachable: never = period;
      return unreachable;
    }
  }
}

function periodTitle(total: PeriodTotal, period: TotalsPeriod): string {
  const { year, month } = dateParts(total.from);
  switch (period) {
    case "week":
      return `Semaine du ${shortDate(total.from)}`;
    case "month":
      return `${monthLong[month - 1] ?? ""} ${year}`;
    case "year":
      return String(year);
    default: {
      const unreachable: never = period;
      return unreachable;
    }
  }
}

interface PeriodTotalsProps {
  readonly sport: SportKey;
  readonly today: LocalDate;
}

/** `SUM-011`, `CAL-005`: distance, moving time, D+, count and energy per week, month or year, recorded and logged alike. */
export function PeriodTotals({ sport, today }: PeriodTotalsProps) {
  const { colors } = useTheme();
  const [period, setPeriod] = useState<TotalsPeriod>("week");
  const [chosen, setChosen] = useState<number | null>(null);
  const totals = useLiveValue(() => periodTotals(completedSessions(db()).filter((item) => item.sport === sport), period, today, periodCount(period)), ["session", "recording"], [sport, period, today]);
  const index = chosen === null || chosen >= totals.length ? totals.length - 1 : chosen;
  const current = totals[index];
  const top = Math.max(1, ...totals.map((total) => total.distanceMeters));
  if (current === undefined) return null;
  const distance = distanceText(current.distanceMeters * 1000);
  const energy =
    current.count === current.withoutEnergy
      ? "sans estimation d'énergie"
      : `${formatInteger(current.energyKcal)} kcal${current.withoutEnergy === 0 ? "" : ` · ${plural(current.withoutEnergy, "activité")} sans estimation`}`;

  return (
    <Section title="Cumuls" action={<LinkButton label="Records" onPress={() => router.push({ pathname: "/records", params: { sport } })} style={styles.link} />}>
      <View style={styles.period}>
        <Segmented<TotalsPeriod>
          options={periodOptions}
          value={period}
          onChange={(value) => {
            setPeriod(value);
            setChosen(null);
          }}
        />
      </View>
      <View style={styles.bars} accessibilityRole="adjustable" accessibilityLabel={`${periodTitle(current, period)} : ${distance.value} ${distance.unit}`}>
        {totals.map((total, position) => (
          <Pressable key={total.from} accessibilityLabel={periodTitle(total, period)} onPress={() => setChosen(position)} style={styles.barColumn}>
            <View style={styles.barTrack}>
              <View style={[styles.bar, { height: Math.max(2, (total.distanceMeters / top) * barsHeight), backgroundColor: position === index ? colors.mark : wash(colors.sport[sport], 0.6) }]} />
            </View>
            <Text style={[styles.barLabel, { color: position === index ? colors.text : colors.text3 }]}>{barLabel(total, period)}</Text>
          </Pressable>
        ))}
      </View>
      <Text variant="bodyStrong" style={styles.title}>
        {periodTitle(current, period)}
      </Text>
      <StatRow
        stats={[
          { label: "Distance", value: distance.value, unit: distance.unit },
          { label: "En mouvement", value: elapsedText(current.movingSeconds * 1000), unit: "" },
          { label: "D+", value: formatInteger(current.ascentMeters), unit: "m" },
        ]}
      />
      <Text variant="small" tone="secondary" style={styles.detail}>
        {current.count === 0 ? "Aucune activité" : `${plural(current.count, "activité")} · ${energy}`}
      </Text>
    </Section>
  );
}

const styles = StyleSheet.create({
  link: { marginVertical: -12, marginRight: -10 },
  period: { marginTop: 12 },
  bars: { flexDirection: "row", gap: 6, marginTop: 14, alignItems: "flex-end" },
  barColumn: { flex: 1, alignItems: "center", gap: 6 },
  barTrack: { height: barsHeight, width: "100%", maxWidth: 28, justifyContent: "flex-end" },
  bar: { width: "100%", borderRadius: 2, transform: [{ skewX: "-8deg" }] },
  barLabel: { fontFamily: fonts.figure600, fontSize: 12, lineHeight: 14 },
  title: { marginTop: 14, marginBottom: 6 },
  detail: { marginTop: 8 },
});
