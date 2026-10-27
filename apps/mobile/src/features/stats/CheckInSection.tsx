import { Pressable, StyleSheet, View } from "react-native";
import { checkInAnswerMutations, checkInZoneMutations, todayCheckIn, checkInZones } from "@obnixe/core";
import type { CheckInAnswer, CheckInContext, CheckInWrite } from "@obnixe/core";
import type { EpochMs, LocalDate, PainLevel, SleepBucket, ZoneKey } from "@obnixe/schema";
import { db, environment } from "@/data/database";
import { useUndoableWrite } from "@/data/write";
import { ZoneRow } from "@/ui/Inputs";
import { Section } from "@/ui/Layout";
import { Text } from "@/ui/Text";
import { useTheme } from "@/ui/theme";
import { fonts, radii, wash } from "@/ui/tokens";
import { levelWords, painWords, sleepLabel } from "@/features/stats/format";
import { deviceTimeZone, formatTimeAt, relativeDay } from "@/format/dates";
import { zoneLabel } from "@/format/labels";
import { useLiveValue } from "@/features/stats/live";

interface EnergyLevel {
  readonly value: number;
  readonly caption?: string;
}

const energyLevels: readonly EnergyLevel[] = [{ value: 1, caption: "à plat" }, { value: 2 }, { value: 3 }, { value: 4 }, { value: 5, caption: "en forme" }];

interface SleepOption {
  readonly value: SleepBucket;
  readonly figure: string;
}

const sleepOptions: readonly SleepOption[] = [
  { value: "lt6", figure: "< 6" },
  { value: "h6", figure: "6" },
  { value: "h7", figure: "7" },
  { value: "h8", figure: "8" },
  { value: "gte9", figure: "9 +" },
];

interface CheckInSectionProps {
  readonly today: LocalDate;
  readonly timeZone: string;
  readonly snackbarOffset: number;
}

export function CheckInSection({ today, timeZone, snackbarOffset }: CheckInSectionProps) {
  const { colors } = useTheme();
  const write = useUndoableWrite();
  const data = useLiveValue(
    () => {
      const current = todayCheckIn(db(), today);
      return { ...current, zones: checkInZones(db(), { today, checkInId: current.checkIn?.id ?? null }) };
    },
    ["check_in", "pain_report", "zone_tracking", "session"],
    [today],
  );

  const context = (): CheckInContext => ({ now: environment.now(), today, timeZone, newId: environment.newId });

  const apply = (result: CheckInWrite, message: string): void => {
    if (result.mutations.length === 0) return;
    write({ summary: "Check-in du jour", mutations: result.mutations, message, aboveTabBar: true, extraOffset: snackbarOffset });
  };

  const answer = (patch: CheckInAnswer, message: string): void => {
    apply(checkInAnswerMutations(data.checkIn, patch, context()), message);
  };

  const setZone = (zone: ZoneKey, level: PainLevel | null): void => {
    const report = data.reports.find((item) => item.zone === zone) ?? null;
    if (data.checkIn === null && level === null) return;
    apply(checkInZoneMutations(data.checkIn, report, zone, level, context()), level === null ? `${zoneLabel(zone)} : retiré` : `${zoneLabel(zone)} : ${levelWords[level]}`);
  };

  const answered = (data.checkIn?.energy == null ? 0 : 1) + (data.checkIn?.sleep == null ? 0 : 1) + data.zones.filter((zone) => zone.todayLevel !== null).length;
  const total = 2 + data.zones.length;
  const savedAt = Math.max(data.checkIn?.updatedAt ?? 0, ...data.reports.map((report) => report.updatedAt)) as EpochMs;

  return (
    <Section
      title="Check-in du jour"
      action={
        answered === 0 ? undefined : (
          <Text variant="caption" tone="secondary">
            {`${answered}/${total} · enregistré à ${formatTimeAt(savedAt, deviceTimeZone())}`}
          </Text>
        )
      }
    >
      <View style={[styles.card, { backgroundColor: colors.surface }]}>
        <View style={styles.question}>
          <Text variant="bodyStrong">Énergie</Text>
          <EnergyMeter value={data.checkIn?.energy ?? null} onChange={(value) => answer({ energy: value }, value === null ? "Énergie retirée" : "Énergie notée")} />
        </View>
        <View style={[styles.question, styles.divided, { borderTopColor: colors.line }]}>
          <View style={styles.questionHead}>
            <Text variant="bodyStrong">Sommeil cette nuit</Text>
            <Text variant="caption" tone="tertiary">
              heures
            </Text>
          </View>
          <SleepDial value={data.checkIn?.sleep ?? null} onChange={(value) => answer({ sleep: value }, value === null ? "Sommeil retiré" : "Sommeil noté")} />
        </View>
        {data.zones.length === 0 ? null : (
          <View style={styles.zones}>
            {data.zones.map((zone) => (
              <ZoneRow
                key={zone.zone}
                name={zoneLabel(zone.zone)}
                {...(zone.latest === null ? {} : { detail: `${painWords[zone.latest.level]} ${relativeDay(zone.latest.localDate, today)}` })}
                value={zone.todayLevel}
                onChange={(level) => setZone(zone.zone, level)}
              />
            ))}
          </View>
        )}
      </View>
    </Section>
  );
}

interface EnergyMeterProps {
  readonly value: number | null;
  readonly onChange: (value: number | null) => void;
}

function EnergyMeter({ value, onChange }: EnergyMeterProps) {
  const { colors } = useTheme();
  return (
    <View>
      <View style={styles.meter} accessibilityRole="radiogroup" accessibilityLabel="Énergie, de 1 (à plat) à 5 (en forme)">
        {energyLevels.map((level, index) => {
          const selected = level.value === value;
          const reached = value !== null && level.value <= value;
          return (
            <Pressable
              key={level.value}
              accessibilityRole="radio"
              aria-checked={selected}
              accessibilityLabel={level.caption === undefined ? String(level.value) : `${level.value}, ${level.caption}`}
              onPress={() => onChange(selected ? null : level.value)}
              style={styles.meterOption}
            >
              {({ pressed }) => (
                <>
                  <View
                    style={[
                      styles.meterBar,
                      { height: 14 + index * 9 },
                      { backgroundColor: selected ? colors.mark : reached ? wash(colors.text, 0.3) : pressed ? colors.surfacePress : colors.surface2 },
                    ]}
                  />
                  <Text tone={selected ? "primary" : "tertiary"} style={[styles.meterFigure, selected && { color: colors.mark }]}>
                    {level.value}
                  </Text>
                </>
              )}
            </Pressable>
          );
        })}
      </View>
      <View style={styles.meterEnds}>
        <Text variant="caption" tone="tertiary">
          à plat
        </Text>
        <Text variant="caption" tone="tertiary">
          en forme
        </Text>
      </View>
    </View>
  );
}

interface SleepDialProps {
  readonly value: SleepBucket | null;
  readonly onChange: (value: SleepBucket | null) => void;
}

function SleepDial({ value, onChange }: SleepDialProps) {
  const { colors } = useTheme();
  return (
    <View style={[styles.dial, { borderBottomColor: colors.line }]} accessibilityRole="radiogroup" accessibilityLabel="Durée de sommeil">
      {sleepOptions.map((option) => {
        const selected = option.value === value;
        return (
          <Pressable
            key={option.value}
            accessibilityRole="radio"
            aria-checked={selected}
            accessibilityLabel={sleepLabel(option.value)}
            onPress={() => onChange(selected ? null : option.value)}
            style={({ pressed }) => [styles.dialOption, pressed && { backgroundColor: colors.surfacePress }]}
          >
            <Text tone={selected ? "primary" : "secondary"} style={[styles.dialFigure, selected && { color: colors.mark }]}>
              {option.figure}
            </Text>
            <View style={[styles.dialTick, { backgroundColor: selected ? colors.mark : colors.controlBorder }, selected && styles.dialTickSelected]} />
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { marginTop: 10, borderRadius: radii.panel, paddingHorizontal: 16, paddingTop: 4, paddingBottom: 6 },
  question: { gap: 10, paddingVertical: 14 },
  divided: { borderTopWidth: 1 },
  questionHead: { flexDirection: "row", alignItems: "baseline", justifyContent: "space-between", gap: 12 },
  meter: { flexDirection: "row", gap: 10, alignItems: "flex-end" },
  meterOption: { flex: 1, minHeight: 72, alignItems: "stretch", justifyContent: "flex-end", gap: 6 },
  meterBar: { borderRadius: 3 },
  meterFigure: { fontFamily: fonts.figure700, fontSize: 18, lineHeight: 19, textAlign: "center" },
  meterEnds: { flexDirection: "row", justifyContent: "space-between", marginTop: 4 },
  dial: { flexDirection: "row", borderBottomWidth: 1 },
  dialOption: { flex: 1, minHeight: 60, alignItems: "center", justifyContent: "flex-end", gap: 8, borderRadius: radii.tag },
  dialFigure: { fontFamily: fonts.figure800, fontSize: 28, lineHeight: 30, letterSpacing: -0.3 },
  dialTick: { width: 1.5, height: 8 },
  dialTickSelected: { width: "60%", height: 3, borderRadius: 1.5 },
  zones: { marginBottom: 2 },
});
