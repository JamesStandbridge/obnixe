import { StyleSheet, View } from "react-native";
import { checkInAnswerMutations, checkInZoneMutations, todayCheckIn, checkInZones } from "@obnixe/core";
import type { CheckInAnswer, CheckInContext, CheckInWrite } from "@obnixe/core";
import type { EpochMs, LocalDate, PainLevel, SleepBucket, ZoneKey } from "@obnixe/schema";
import { db, environment } from "@/data/database";
import { useUndoableWrite } from "@/data/write";
import { Question, Scale, ZoneRow } from "@/ui/Inputs";
import type { ScaleOption } from "@/ui/Inputs";
import { Section } from "@/ui/Layout";
import { Text } from "@/ui/Text";
import { levelWords, painWords } from "@/features/stats/format";
import { deviceTimeZone, formatTimeAt, relativeDay } from "@/format/dates";
import { zoneLabel } from "@/format/labels";
import { useLiveValue } from "@/features/stats/live";

const energyOptions: readonly ScaleOption<number>[] = [
  { value: 1, label: "1", caption: "à plat" },
  { value: 2, label: "2" },
  { value: 3, label: "3" },
  { value: 4, label: "4" },
  { value: 5, label: "5", caption: "en forme" },
];

const sleepOptions: readonly ScaleOption<SleepBucket>[] = [
  { value: "lt6", label: "< 6 h" },
  { value: "h6", label: "6 h" },
  { value: "h7", label: "7 h" },
  { value: "h8", label: "8 h" },
  { value: "gte9", label: "9 h +" },
];

interface CheckInSectionProps {
  readonly today: LocalDate;
  readonly timeZone: string;
  readonly snackbarOffset: number;
}

export function CheckInSection({ today, timeZone, snackbarOffset }: CheckInSectionProps) {
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
      <Question title="Énergie">
        <Scale<number>
          label="Énergie, de 1 (à plat) à 5 (en forme)"
          options={energyOptions}
          value={data.checkIn?.energy ?? null}
          optional
          onChange={(value) => answer({ energy: value }, value === null ? "Énergie retirée" : "Énergie notée")}
        />
      </Question>
      <Question title="Sommeil cette nuit">
        <Scale<SleepBucket>
          label="Durée de sommeil"
          options={sleepOptions}
          value={data.checkIn?.sleep ?? null}
          optional
          onChange={(value) => answer({ sleep: value }, value === null ? "Sommeil retiré" : "Sommeil noté")}
        />
      </Question>
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
    </Section>
  );
}

const styles = StyleSheet.create({
  zones: { marginTop: 12 },
});
