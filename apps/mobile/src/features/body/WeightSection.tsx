import { useState } from "react";
import type { ReactNode } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { addDays, epochAt, gramsToMass, massToGrams, massUnitOf, planTrash, planWeighIn, weighInBounds, weightTrend } from "@obnixe/core";
import type { MassUnit, LocalDate, WeighIn } from "@obnixe/schema";
import { db, environment } from "@/data/database";
import { useUndoableWrite } from "@/data/write";
import { capitalize, deviceTimeZone, formatNumber, formatRelativeDay, formatShortDay, formatSigned, todayLocal, weekdayInitial, weekdayName } from "@/features/activity/format";
import { PadSheet } from "@/features/activity/PadSheet";
import type { PadResult } from "@/features/activity/PadSheet";
import { Sparkline } from "@/features/body/Sparkline";
import { LinkButton } from "@/ui/Button";
import { Section, Row } from "@/ui/Layout";
import { Text } from "@/ui/Text";
import { useTheme } from "@/ui/theme";
import { fonts, layout, radii } from "@/ui/tokens";

interface WeightSectionProps {
  readonly weighIns: readonly WeighIn[];
  readonly massUnit: MassUnit;
  readonly children: ReactNode;
}

type DaySheet = { readonly kind: "none" } | { readonly kind: "today" } | { readonly kind: "day"; readonly date: LocalDate };

const defaultGrams = 70_000;
const historyStep = 5;

export function WeightSection({ weighIns, massUnit, children }: WeightSectionProps) {
  const { colors } = useTheme();
  const undoable = useUndoableWrite();
  const today = todayLocal();
  const timeZone = deviceTimeZone();
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

  const context = ((): { readonly lead: string; readonly strong: string; readonly rest: string } | null => {
    if (touched || trend.today !== null) {
      if (trend.average7 === null) return null;
      const average = `Moyenne 7 jours ${formatNumber(gramsToMass(trend.average7, massUnit), unit.decimals)} ${unit.symbol}`;
      return { lead: "", strong: average, rest: trend.delta30 === null ? "" : ` · ${formatSigned(trend.delta30 / unit.factor, unit.decimals)} ${unit.symbol} en 30 jours` };
    }
    if (trend.latest === null) return { lead: "Première pesée", strong: "", rest: "" };
    return { lead: `${formatRelativeDay(trend.latest.localDate, today)} `, strong: `${formatNumber(gramsToMass(trend.latest.grams, massUnit), unit.decimals)} ${unit.symbol}`, rest: "" };
  })();

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
  const sparkPoints = [...weighIns].filter((row) => row.localDate >= addDays(today, -90)).sort((left, right) => left.localDate.localeCompare(right.localDate));
  const history = [...weighIns].sort((left, right) => right.localDate.localeCompare(left.localDate));

  return (
    <>
      <View style={styles.weight}>
        <Text variant="eyebrow" tone="secondary">
          Pesée du jour
        </Text>
        <View style={styles.stepper}>
          <StepButton label="−" accessibilityLabel={massUnit === "kg" ? "Retirer 100 g" : "Retirer 0,1 lb"} disabled={shown <= min} onPress={() => step(-1)} />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Saisir le poids, ${label}${!touched && trend.today === null ? ", proposé" : ""}`}
            onPress={() => setSheet({ kind: "today" })}
            style={({ pressed }) => [styles.stepValue, pressed && { backgroundColor: colors.surface }]}
          >
            <Text style={[styles.weightValue, { color: !touched && trend.today === null ? colors.text3 : colors.text }]} maxFontSizeMultiplier={1.1}>
              {formatNumber(shown, unit.decimals)}
            </Text>
            <Text variant="small" tone="secondary" style={styles.unit}>
              {unit.symbol}
            </Text>
          </Pressable>
          <StepButton label="+" accessibilityLabel={massUnit === "kg" ? "Ajouter 100 g" : "Ajouter 0,1 lb"} disabled={shown >= max} onPress={() => step(1)} />
        </View>
        {context === null ? null : (
          <Text variant="small" tone="secondary" style={styles.comparison}>
            {context.lead}
            <Text style={styles.comparisonStrong}>{context.strong}</Text>
            {context.rest}
          </Text>
        )}
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ disabled: isSaved }}
          disabled={isSaved}
          onPress={() => {
            save(shown, today);
            setDraft(null);
          }}
          style={({ pressed }) => [
            styles.save,
            isSaved ? { backgroundColor: colors.surface } : { backgroundColor: pressed ? colors.surfacePress : colors.surface, borderColor: colors.controlBorder, borderWidth: layout.borderControl },
          ]}
        >
          <Text variant="label" tone={isSaved ? "secondary" : "primary"}>
            {isSaved ? `Pesée enregistrée · ${label}` : savedValue !== null ? `Remplacer par ${label}` : `Enregistrer ${label}`}
          </Text>
        </Pressable>
        <View style={styles.days} accessibilityLabel="7 derniers jours">
          {trend.days.map((day) => {
            const isToday = day.localDate === today;
            return (
              <Pressable
                key={day.localDate}
                accessibilityRole="button"
                accessibilityLabel={`${capitalize(weekdayName(day.localDate))}, ${day.grams === null ? "pas de pesée" : `${formatNumber(gramsToMass(day.grams, massUnit), unit.decimals)} ${unit.symbol}`}`}
                onPress={() => setSheet({ kind: "day", date: day.localDate })}
                style={({ pressed }) => [
                  styles.day,
                  { backgroundColor: pressed ? colors.surfacePress : isToday ? colors.surface2 : colors.surface },
                  isToday && { borderBottomColor: colors.mark, borderBottomWidth: 3 },
                ]}
              >
                <Text style={styles.dayInitial} tone="secondary">
                  {weekdayInitial(day.localDate)}
                </Text>
                <Text style={styles.dayValue} tone={day.grams === null ? "tertiary" : "primary"}>
                  {day.grams === null ? "–" : formatNumber(gramsToMass(day.grams, massUnit), unit.decimals)}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </View>

      {children}

      {history.length === 0 ? null : (
        <Section title="Pesées · 90 jours">
          {sparkPoints.length > 1 ? (
            <View style={styles.spark}>
              <Sparkline values={sparkPoints.map((row) => row.grams)} />
            </View>
          ) : null}
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
              removeLabel: "Supprimer la pesée",
              onRemove: () => {
                setSheet({ kind: "none" });
                remove(dayRow);
              },
            })}
        onSubmit={submitPad}
        onClose={() => setSheet({ kind: "none" })}
      />
    </>
  );
}

interface StepButtonProps {
  readonly label: string;
  readonly accessibilityLabel: string;
  readonly disabled: boolean;
  readonly onPress: () => void;
}

function StepButton({ label, accessibilityLabel, disabled, onPress }: StepButtonProps) {
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [styles.step, { backgroundColor: pressed ? colors.surfacePress : colors.surface, borderColor: colors.controlBorder }, disabled && styles.disabled]}
    >
      <Text style={styles.stepLabel}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  weight: { marginTop: 18, gap: 10 },
  stepper: { flexDirection: "row", alignItems: "center", gap: 6 },
  step: { width: 64, height: 72, borderRadius: radii.control, borderWidth: layout.borderControl, alignItems: "center", justifyContent: "center" },
  stepLabel: { fontFamily: fonts.figure700, fontSize: 22, lineHeight: 24 },
  stepValue: { flex: 1, height: 72, borderRadius: radii.control, flexDirection: "row", alignItems: "baseline", justifyContent: "center", gap: 6 },
  weightValue: { fontFamily: fonts.figure800, fontSize: 64, lineHeight: 72, letterSpacing: -0.6 },
  unit: { fontFamily: fonts.text600 },
  comparison: { textAlign: "center" },
  comparisonStrong: { fontFamily: fonts.text600, fontSize: 15 },
  save: { minHeight: 48, borderRadius: radii.control, alignItems: "center", justifyContent: "center", paddingHorizontal: 14 },
  days: { flexDirection: "row", gap: 2, borderRadius: radii.panel, overflow: "hidden" },
  day: { flex: 1, minHeight: 52, paddingVertical: 10, alignItems: "center", gap: 6 },
  dayInitial: { fontFamily: fonts.text700, fontSize: 12, lineHeight: 12 },
  dayValue: { fontFamily: fonts.figure700, fontSize: 16, lineHeight: 17 },
  disabled: { opacity: 0.4 },
  spark: { marginTop: 12, marginBottom: 4 },
  more: { alignItems: "center", marginTop: 4 },
});
