import { useState } from "react";
import type { ReactNode } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { addDays, epochAt, gramsToMass, localDateOf, massToGrams, massUnitOf, planTrash, planWeighIn, weighInBounds, weightTrend } from "@obnixe/core";
import type { MassUnit, LocalDate, WeighIn } from "@obnixe/schema";
import { db, environment } from "@/data/database";
import { useUndoableWrite } from "@/data/write";
import { formatRelativeDay, formatShortDay, weekdayInitial, weekdayName } from "@/features/activity/format";
import { capitalize } from "@/format/labels";
import { deviceTimeZone } from "@/format/dates";
import { formatNumber, formatSigned } from "@/format/numbers";
import { PadSheet } from "@/ui/PadSheet";
import type { PadResult } from "@/ui/PadSheet";
import { WeightChart } from "@/features/body/WeightChart";
import { LinkButton } from "@/ui/Button";
import { Section, Row } from "@/ui/Layout";
import { StatRow } from "@/ui/Stats";
import type { StatValue } from "@/ui/Stats";
import { Text } from "@/ui/Text";
import { StepButton } from "@/ui/Controls";
import { useTheme } from "@/ui/theme";
import { fonts, radii } from "@/ui/tokens";

interface WeightSectionProps {
  readonly weighIns: readonly WeighIn[];
  readonly massUnit: MassUnit;
  readonly children: ReactNode;
}

type DaySheet = { readonly kind: "none" } | { readonly kind: "today" } | { readonly kind: "day"; readonly date: LocalDate };

const defaultGrams = 70_000;
const historyStep = 5;
const chartDays = 60;

export function WeightSection({ weighIns, massUnit, children }: WeightSectionProps) {
  const { colors } = useTheme();
  const undoable = useUndoableWrite();
  const timeZone = deviceTimeZone();
  const today = localDateOf(environment.now(), timeZone);
  const unit = massUnitOf(massUnit);
  const [draft, setDraft] = useState<number | null>(null);
  const [sheet, setSheet] = useState<DaySheet>({ kind: "none" });
  const [historyLength, setHistoryLength] = useState(historyStep);

  const points = weighIns.map((row) => ({ localDate: row.localDate, grams: row.grams }));
  const trend = weightTrend(points, today);
  const base = gramsToMass(trend.today?.grams ?? trend.latest?.grams ?? defaultGrams, massUnit);
  const shown = draft ?? base;
  const touched = draft !== null;
  const savedValue = trend.today === null ? null : gramsToMass(trend.today.grams, massUnit);
  const isSaved = savedValue !== null && savedValue === shown;
  const label = `${formatNumber(shown, unit.decimals)} ${unit.symbol}`;
  const min = gramsToMass(weighInBounds.minGrams, massUnit);
  const max = gramsToMass(weighInBounds.maxGrams, massUnit);

  const save = (value: number, date: LocalDate): void => {
    const occurredAt = date === today ? environment.now() : epochAt({ date, minutes: 8 * 60 }, timeZone);
    const plan = planWeighIn(db(), environment, { grams: massToGrams(value, massUnit), occurredAt, timeZone });
    const text = `${formatNumber(value, unit.decimals)} ${unit.symbol}`;
    undoable({
      summary: date === today ? "Pesée du jour" : `Pesée du ${formatShortDay(date)}`,
      mutations: [plan.mutation],
      message: date === today ? `Pesée du jour enregistrée · ${text}` : `Pesée ${plan.replaced === null ? "ajoutée" : "corrigée"} · ${formatShortDay(date)}`,
    });
  };

  const remove = (row: WeighIn): void => {
    undoable({ summary: "Pesée supprimée", mutations: [planTrash(environment, "weigh_in", row.id)], message: `Pesée supprimée · ${formatShortDay(row.localDate)}` });
  };

  const context = touched ? "À enregistrer" : trend.latest === null ? "Première pesée" : formatRelativeDay(trend.latest.localDate, today);
  const stats: StatValue[] = [];
  if (trend.average7 !== null) stats.push({ label: "Moyenne 7 j", value: formatNumber(gramsToMass(trend.average7, massUnit), unit.decimals), unit: unit.symbol });
  if (trend.delta7 !== null) stats.push({ label: "Sur 7 jours", value: formatSigned(trend.delta7 / unit.factor, unit.decimals), unit: unit.symbol });
  if (trend.delta30 !== null) stats.push({ label: "Sur 30 jours", value: formatSigned(trend.delta30 / unit.factor, unit.decimals), unit: unit.symbol });
  const formatGrams = (grams: number): string => formatNumber(gramsToMass(grams, massUnit), unit.decimals);

  const step = (direction: 1 | -1): void => {
    const next = Math.round((shown + direction / 10) * 10) / 10;
    setDraft(Math.min(max, Math.max(min, next)));
  };

  const submitPad = (result: PadResult): void => {
    const target = sheet;
    setSheet({ kind: "none" });
    if (target.kind === "today") {
      if (result.kind === "value") setDraft(result.value);
      return;
    }
    if (target.kind !== "day") return;
    const existing = weighIns.find((row) => row.localDate === target.date);
    const value = result.kind === "value" ? result.value : existing === undefined ? null : gramsToMass(existing.grams, massUnit);
    if (value !== null) save(value, target.date);
  };

  const dayRow = sheet.kind === "day" ? weighIns.find((row) => row.localDate === sheet.date) : undefined;
  const chartStart = addDays(today, -(chartDays - 1));
  const chartPoints = points.filter((point) => point.localDate >= chartStart && point.localDate <= today).sort((left, right) => left.localDate.localeCompare(right.localDate));
  const history = [...weighIns].sort((left, right) => right.localDate.localeCompare(left.localDate));
  const proposed = !touched && trend.latest === null;

  return (
    <>
      <View style={styles.weight}>
        <View style={[styles.instrument, { backgroundColor: colors.surface }]}>
          <View style={styles.instrumentHead}>
            <Text variant="eyebrow" tone="secondary">
              Poids
            </Text>
            <Text variant="caption" style={{ color: touched ? colors.mark : colors.text2 }}>
              {context}
            </Text>
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Saisir le poids, ${label}${touched ? ", à enregistrer" : trend.today === null ? ", proposé" : ""}`}
            onPress={() => setSheet({ kind: "today" })}
            style={({ pressed }) => [styles.figure, pressed && { opacity: 0.7 }]}
          >
            <Text style={[styles.weightValue, { color: proposed ? colors.text3 : colors.text }]} maxFontSizeMultiplier={1.1}>
              {formatNumber(shown, unit.decimals)}
            </Text>
            <Text tone="secondary" style={styles.unit}>
              {unit.symbol}
            </Text>
          </Pressable>
          {stats.length === 0 ? null : <StatRow stats={stats} style={styles.stats} />}
          {chartPoints.length > 1 ? (
            <View style={[styles.chart, { borderTopColor: colors.line }]}>
              <WeightChart
                points={chartPoints}
                start={chartStart}
                end={today}
                formatValue={formatGrams}
                accessibilityLabel={`Courbe du poids sur ${chartDays} jours, ${chartPoints.length} pesées, de ${formatGrams(Math.min(...chartPoints.map((point) => point.grams)))} à ${formatGrams(Math.max(...chartPoints.map((point) => point.grams)))} ${unit.symbol}`}
              />
            </View>
          ) : null}
        </View>
        <View style={styles.stepper}>
          <StepButton label="−" accessibilityLabel={massUnit === "kg" ? "Retirer 100 g" : "Retirer 0,1 lb"} disabled={shown <= min} onPress={() => step(-1)} />
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ disabled: isSaved }}
            disabled={isSaved}
            onPress={() => {
              save(shown, today);
              setDraft(null);
            }}
            style={({ pressed }) => [styles.save, isSaved ? { backgroundColor: colors.surface } : { backgroundColor: pressed ? colors.actPress : colors.actBg }]}
          >
            <Text variant="label" tone={isSaved ? "secondary" : "act"} style={isSaved ? undefined : styles.saveLabel}>
              {isSaved ? `Pesée enregistrée · ${label}` : savedValue !== null ? `Remplacer par ${label}` : `Enregistrer ${label}`}
            </Text>
          </Pressable>
          <StepButton label="+" accessibilityLabel={massUnit === "kg" ? "Ajouter 100 g" : "Ajouter 0,1 lb"} disabled={shown >= max} onPress={() => step(1)} />
        </View>
        <View style={[styles.days, { borderColor: colors.line }]} accessibilityLabel="7 derniers jours">
          {trend.days.map((day) => {
            const isToday = day.localDate === today;
            return (
              <Pressable
                key={day.localDate}
                accessibilityRole="button"
                accessibilityLabel={`${capitalize(weekdayName(day.localDate))}, ${day.grams === null ? "pas de pesée" : `${formatNumber(gramsToMass(day.grams, massUnit), unit.decimals)} ${unit.symbol}`}`}
                onPress={() => setSheet({ kind: "day", date: day.localDate })}
                style={({ pressed }) => [styles.day, pressed && { backgroundColor: colors.surfacePress }]}
              >
                <Text style={styles.dayInitial} tone={isToday ? "primary" : "tertiary"}>
                  {weekdayInitial(day.localDate)}
                </Text>
                <Text style={styles.dayValue} tone={day.grams === null ? "tertiary" : "primary"}>
                  {day.grams === null ? "–" : formatNumber(gramsToMass(day.grams, massUnit), unit.decimals)}
                </Text>
                <View style={[styles.dayMark, { backgroundColor: isToday ? colors.mark : "transparent" }]} />
              </Pressable>
            );
          })}
        </View>
      </View>

      {children}

      {history.length === 0 ? null : (
        <Section title="Pesées">
          {history.slice(0, historyLength).map((row, index, list) => (
            <Row
              key={row.id}
              title={formatRelativeDay(row.localDate, today)}
              value={formatNumber(gramsToMass(row.grams, massUnit), unit.decimals)}
              valueDetail={unit.symbol}
              last={index === list.length - 1}
              onPress={() => setSheet({ kind: "day", date: row.localDate })}
            />
          ))}
          {history.length > historyLength ? (
            <View style={styles.more}>
              <LinkButton label="Afficher plus" onPress={() => setHistoryLength(historyLength + historyStep * 3)} />
            </View>
          ) : null}
        </Section>
      )}

      <PadSheet
        open={sheet.kind !== "none"}
        title={sheet.kind === "day" ? `Pesée · ${formatRelativeDay(sheet.date, today).toLowerCase()}` : "Poids"}
        mode="number"
        unit={unit.symbol}
        decimals={unit.decimals}
        current={sheet.kind === "today" ? formatNumber(shown, unit.decimals) : dayRow === undefined ? null : formatNumber(gramsToMass(dayRow.grams, massUnit), unit.decimals)}
        validate={(value) => (value < min || value > max ? `Entre ${formatNumber(min, 0)} et ${formatNumber(max, 0)} ${unit.symbol}` : null)}
        {...(dayRow === undefined
          ? {}
          : {
              action: {
                label: "Supprimer la pesée",
                appearance: "link",
                onPress: () => {
                  setSheet({ kind: "none" });
                  remove(dayRow);
                },
              },
            })}
        onSubmit={submitPad}
        onClose={() => setSheet({ kind: "none" })}
      />
    </>
  );
}

const styles = StyleSheet.create({
  weight: { marginTop: 18, gap: 10 },
  instrument: { borderRadius: radii.panel, padding: 16, paddingBottom: 14 },
  instrumentHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 },
  figure: { flexDirection: "row", alignItems: "baseline", alignSelf: "flex-start", gap: 6, minHeight: 44, marginTop: 6 },
  weightValue: { fontFamily: fonts.figure800, fontSize: 76, lineHeight: 78, letterSpacing: -1.6 },
  unit: { fontFamily: fonts.figure700, fontSize: 22, lineHeight: 24 },
  stats: { marginTop: 10 },
  chart: { marginTop: 14, paddingTop: 12, borderTopWidth: 1 },
  stepper: { flexDirection: "row", alignItems: "stretch", gap: 6 },
  save: { flex: 1, minHeight: 56, borderRadius: radii.control, alignItems: "center", justifyContent: "center", paddingHorizontal: 12 },
  saveLabel: { fontFamily: fonts.text700, fontSize: 16 },
  days: { flexDirection: "row", borderTopWidth: 1, borderBottomWidth: 1 },
  day: { flex: 1, minHeight: 56, paddingTop: 10, alignItems: "center", gap: 5 },
  dayInitial: { fontFamily: fonts.text700, fontSize: 12, lineHeight: 12 },
  dayValue: { fontFamily: fonts.figure700, fontSize: 16, lineHeight: 17 },
  dayMark: { marginTop: "auto", alignSelf: "stretch", marginHorizontal: 8, height: 3, borderTopLeftRadius: 2, borderTopRightRadius: 2 },
  more: { alignItems: "center", marginTop: 4 },
});
