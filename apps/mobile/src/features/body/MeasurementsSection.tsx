import { useEffect, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { DuplicateKindError, EmptyKindLabelError, epochAt, localDateOf, measurementsOverview, planKindArchive, planMeasurement, planMeasurementKind, planTrash } from "@obnixe/core";
import type { Id, LocalDate, Measurement, MeasurementKind } from "@obnixe/schema";
import { db, environment } from "@/data/database";
import { useUndoableWrite, write } from "@/data/write";
import { formatDayMonth, formatRelativeDay } from "@/features/activity/format";
import { deviceTimeZone } from "@/format/dates";
import { formatNumber, formatSigned } from "@/format/numbers";
import { PadSheet } from "@/ui/PadSheet";
import { ControlButton, LinkButton, SheetButton } from "@/ui/Button";
import { Icon } from "@/ui/icons/Icon";
import { MenuItem, TextField } from "@/ui/Inputs";
import { Row, Section } from "@/ui/Layout";
import { Sheet } from "@/ui/Overlays";
import { Text } from "@/ui/Text";
import { useTheme } from "@/ui/theme";
import { fonts } from "@/ui/tokens";

interface MeasurementsSectionProps {
  readonly kinds: readonly MeasurementKind[];
  readonly measurements: readonly Measurement[];
}

type MeasureSheet =
  | { readonly kind: "none" }
  | { readonly kind: "list" }
  | { readonly kind: "pad"; readonly kindId: Id; readonly date: LocalDate; readonly back: "list" | "history" }
  | { readonly kind: "new" }
  | { readonly kind: "history"; readonly kindId: Id };

const suggestions = ["Tour de taille", "Hanches", "Poitrine", "Bras droit, contracté", "Cuisse droite"] as const;

function centimeters(millimeters: number): string {
  return formatNumber(millimeters / 10, 1);
}

function deltaLabel(delta: number | null): string | undefined {
  if (delta === null) return undefined;
  if (delta === 0) return "stable";
  return `${formatSigned(delta / 10, 1)} cm`;
}

export function MeasurementsSection({ kinds, measurements }: MeasurementsSectionProps) {
  const { colors } = useTheme();
  const undoable = useUndoableWrite();
  const timeZone = deviceTimeZone();
  const today = localDateOf(environment.now(), timeZone);
  const [sheet, setSheet] = useState<MeasureSheet>({ kind: "none" });
  const [label, setLabel] = useState("");
  const [labelError, setLabelError] = useState<string | null>(null);

  useEffect(() => {
    if (sheet.kind === "new") {
      setLabel("");
      setLabelError(null);
    }
  }, [sheet.kind]);

  const overview = measurementsOverview(kinds, measurements);
  const live = measurements.filter((row) => row.deletedAt === null);
  const todayOf = (kindId: Id): Measurement | undefined => live.find((row) => row.kindId === kindId && row.localDate === today);
  const kindOf = (kindId: Id): MeasurementKind | undefined => kinds.find((kind) => kind.id === kindId);
  const existingLabels = new Set(kinds.filter((kind) => kind.archivedAt === null).map((kind) => kind.label.toLowerCase()));

  const createKind = (value: string): void => {
    try {
      const plan = planMeasurementKind(db(), environment, value);
      write(`Mensuration : ${value.trim()}`, [plan.mutation]);
      setSheet({ kind: "pad", kindId: plan.kindId, date: today, back: "list" });
    } catch (error) {
      if (error instanceof DuplicateKindError) {
        setLabelError("Existe déjà");
        return;
      }
      if (error instanceof EmptyKindLabelError) {
        setLabelError("Donne un nom");
        return;
      }
      throw error;
    }
  };

  const padKind = sheet.kind === "pad" ? kindOf(sheet.kindId) : undefined;
  const padCurrent =
    sheet.kind !== "pad"
      ? null
      : sheet.date === today
        ? (todayOf(sheet.kindId) ?? overview.kinds.find((summary) => summary.kind.id === sheet.kindId)?.latest ?? null)
        : (live.find((row) => row.kindId === sheet.kindId && row.localDate === sheet.date) ?? null);
  const historyKind = sheet.kind === "history" ? kindOf(sheet.kindId) : undefined;
  const history = sheet.kind === "history" ? live.filter((row) => row.kindId === sheet.kindId).sort((left, right) => right.localDate.localeCompare(left.localDate)) : [];

  return (
    <>
      <Section
        title={overview.latestDate === null ? "Mensurations" : `Mensurations · ${formatDayMonth(overview.latestDate)}`}
        action={<LinkButton label="Mesurer" onPress={() => setSheet({ kind: overview.kinds.length === 0 ? "new" : "list" })} style={styles.headLink} />}
      >
        {overview.kinds.length === 0 ? (
          <Text variant="small" tone="secondary" style={styles.empty}>
            Ajoute les tours que tu veux suivre, en centimètres.
          </Text>
        ) : (
          overview.kinds.map((summary, index) => (
            <Row
              key={summary.kind.id}
              title={summary.kind.label}
              {...(deltaLabel(summary.delta) === undefined ? {} : { detail: deltaLabel(summary.delta) })}
              {...(summary.latest === null ? { value: "–" } : { value: centimeters(summary.latest.millimeters), valueDetail: "cm" })}
              last={index === overview.kinds.length - 1}
              onPress={() => setSheet({ kind: "history", kindId: summary.kind.id })}
            />
          ))
        )}
      </Section>

      <Sheet open={sheet.kind === "list"} title="Mesurer" context="Aujourd'hui" onClose={() => setSheet({ kind: "none" })}>
        <View>
          {overview.kinds.map((summary) => {
            const done = todayOf(summary.kind.id);
            return (
              <Pressable
                key={summary.kind.id}
                accessibilityRole="button"
                accessibilityLabel={`${summary.kind.label}, ${done === undefined ? "à mesurer" : `${centimeters(done.millimeters)} cm aujourd'hui`}`}
                onPress={() => setSheet({ kind: "pad", kindId: summary.kind.id, date: today, back: "list" })}
                style={({ pressed }) => [styles.measureRow, { borderTopColor: colors.line }, pressed && { backgroundColor: colors.surfacePress }]}
              >
                <Text style={styles.measureLabel} numberOfLines={1}>
                  {summary.kind.label}
                </Text>
                {done === undefined ? (
                  <Text variant="label" tone="tertiary">
                    {summary.latest === null ? "Ajouter" : `${centimeters(summary.latest.millimeters)} cm`}
                  </Text>
                ) : (
                  <>
                    <Text variant="value">{centimeters(done.millimeters)}</Text>
                    <Icon name="check" size={18} />
                  </>
                )}
              </Pressable>
            );
          })}
          <MenuItem label="Nouvelle mensuration" onPress={() => setSheet({ kind: "new" })} />
        </View>
        <SheetButton label="Terminé" style={styles.confirm} onPress={() => setSheet({ kind: "none" })} />
      </Sheet>

      <Sheet open={sheet.kind === "new"} title="Nouvelle mensuration" onClose={() => setSheet({ kind: "none" })}>
        <View style={styles.create}>
          <TextField value={label} onChangeText={setLabel} placeholder="Ex. tour de mollet" accessibilityLabel="Nom de la mensuration" style={styles.createField} autoFocus />
          <ControlButton label="Ajouter" disabled={label.trim() === ""} onPress={() => createKind(label)} />
        </View>
        {labelError === null ? null : (
          <Text variant="small" style={[styles.error, { color: colors.stop }]}>
            {labelError}
          </Text>
        )}
        <View style={styles.suggestions}>
          {suggestions
            .filter((suggestion) => !existingLabels.has(suggestion.toLowerCase()))
            .map((suggestion) => (
              <MenuItem key={suggestion} label={suggestion} onPress={() => createKind(suggestion)} />
            ))}
        </View>
      </Sheet>

      <PadSheet
        open={sheet.kind === "pad"}
        title={sheet.kind === "pad" && sheet.date !== today ? `${padKind?.label ?? ""} · ${formatRelativeDay(sheet.date, today).toLowerCase()}` : (padKind?.label ?? "")}
        mode="number"
        unit="cm"
        decimals={1}
        current={padCurrent === null ? null : centimeters(padCurrent.millimeters)}
        validate={(value) => (value <= 0 || value > 400 ? "Entre 1 et 400 cm" : null)}
        onSubmit={(result) => {
          if (sheet.kind !== "pad") return;
          const millimeters = result.kind === "value" ? Math.round(result.value * 10) : (padCurrent?.millimeters ?? null);
          if (millimeters !== null) {
            const occurredAt = sheet.date === today ? environment.now() : epochAt({ date: sheet.date, minutes: 8 * 60 }, timeZone);
            const plan = planMeasurement(db(), environment, { kindId: sheet.kindId, millimeters, occurredAt, timeZone });
            write(`Mensuration : ${padKind?.label ?? ""}`, [plan.mutation]);
          }
          setSheet(sheet.back === "list" ? { kind: "list" } : { kind: "history", kindId: sheet.kindId });
        }}
        onClose={() => setSheet(sheet.kind === "pad" && sheet.back === "history" ? { kind: "history", kindId: sheet.kindId } : { kind: "list" })}
      />

      <Sheet open={sheet.kind === "history"} title={historyKind?.label ?? ""} context={history.length === 0 ? "Aucune mesure" : `${history.length} mesure${history.length > 1 ? "s" : ""}`} onClose={() => setSheet({ kind: "none" })}>
        {history.slice(0, 24).map((row) => (
          <View key={row.id} style={[styles.historyRow, { borderTopColor: colors.line }]}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`${formatRelativeDay(row.localDate, today)}, ${centimeters(row.millimeters)} cm, corriger`}
              onPress={() => setSheet({ kind: "pad", kindId: row.kindId, date: row.localDate, back: "history" })}
              style={({ pressed }) => [styles.historyEntry, pressed && { backgroundColor: colors.surfacePress }]}
            >
              <Text variant="bodyStrong" style={styles.historyDate}>
                {formatRelativeDay(row.localDate, today)}
              </Text>
              <Text variant="value">
                {centimeters(row.millimeters)}
                <Text variant="caption" tone="secondary">
                  {" cm"}
                </Text>
              </Text>
            </Pressable>
            <LinkButton
              label="Supprimer"
              onPress={() => {
                setSheet({ kind: "none" });
                undoable({ summary: "Mesure supprimée", mutations: [planTrash(environment, "measurement", row.id)], message: `${historyKind?.label ?? "Mesure"} · ${formatRelativeDay(row.localDate, today).toLowerCase()} supprimée` });
              }}
            />
          </View>
        ))}
        {sheet.kind === "history" ? <SheetButton label="Mesurer aujourd'hui" style={styles.confirm} onPress={() => setSheet({ kind: "pad", kindId: sheet.kindId, date: today, back: "history" })} /> : null}
        {sheet.kind === "history" && historyKind !== undefined ? (
          <View style={styles.archive}>
            <LinkButton
              label="Ne plus suivre"
              onPress={() => {
                setSheet({ kind: "none" });
                undoable({ summary: `Mensuration retirée : ${historyKind.label}`, mutations: [planKindArchive(environment, historyKind.id)], message: `${historyKind.label} retirée` });
              }}
            />
          </View>
        ) : null}
      </Sheet>
    </>
  );
}

const styles = StyleSheet.create({
  headLink: { marginVertical: -12, marginRight: -10 },
  empty: { paddingVertical: 14 },
  measureRow: { flexDirection: "row", alignItems: "center", gap: 10, minHeight: 56, borderTopWidth: 1 },
  measureLabel: { flex: 1, fontFamily: fonts.text600, fontSize: 17, lineHeight: 22 },
  confirm: { marginTop: 14 },
  create: { flexDirection: "row", gap: 8, alignItems: "center", marginTop: 4 },
  createField: { flex: 1 },
  error: { marginTop: 6 },
  suggestions: { marginTop: 12 },
  historyRow: { flexDirection: "row", alignItems: "center", gap: 12, minHeight: 52, borderTopWidth: 1 },
  historyEntry: { flex: 1, flexDirection: "row", alignItems: "center", gap: 12, minHeight: 52 },
  historyDate: { flex: 1 },
  archive: { alignItems: "center", marginTop: 8 },
});
