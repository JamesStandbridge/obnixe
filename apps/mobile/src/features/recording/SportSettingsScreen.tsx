import { useMemo, useState } from "react";
import { StyleSheet, View } from "react-native";
import { router } from "expo-router";
import { useLiveQuery } from "drizzle-orm/expo-sqlite";
import { eq } from "drizzle-orm";
import { defaultRecordingSettings, heartRateZoneKeys, maxHeartRateOf, recordingSettingsMutation, resolveProfile } from "@obnixe/core";
import type { HeartRateZone, ResolvedProfile } from "@obnixe/core";
import { recordingAlerts, sportPreference, sports } from "@obnixe/schema";
import type { HeartRateRange, PaceRange, Readout, RecordingSettings, SportKey } from "@obnixe/schema";
import { db, environment } from "@/data/database";
import { usePhysiology } from "@/data/settings";
import { write } from "@/data/write";
import { BackButton, Chevron, SwitchRow } from "@/features/data/parts";
import { heartRateSpanBpm } from "@/features/recording/alerts";
import { paceUnit } from "@/features/recording/metrics";
import { liveReadout, storedReadout } from "@/features/recording/readout";
import { ReadoutEditor } from "@/features/recording/ReadoutEditor";
import {
  alertLabel,
  autoLapChoiceOf,
  autoLapLabel,
  autoLapOptions,
  defaultPaceRange,
  formatKmhTenths,
  heartRateRangeLabel,
  kmhTenthsToMmS,
  mmSToKmhTenths,
  paceBoundsOf,
  paceRangeLabel,
  paceStepSeconds,
  speedBoundsKmhTenths,
  speedStepKmhTenths,
  withAlert,
  withZoneEnd,
} from "@/features/recording/settings";
import { formatClock } from "@/format/durations";
import { LinkButton } from "@/ui/Button";
import { Segmented, Stepper } from "@/ui/Controls";
import { Choices } from "@/ui/Inputs";
import { AppBar, Row, Screen, Section } from "@/ui/Layout";
import { Sheet } from "@/ui/Overlays";
import { Text } from "@/ui/Text";

type OpenSheet = "auto_lap" | "pace" | "heart_rate" | null;

interface SportSettingsScreenProps {
  readonly sport: SportKey;
}

/** The sport's recording settings, stored without the profile's defaults once changed. */
function useSportSettings(sport: SportKey, profile: ResolvedProfile): RecordingSettings {
  const { data } = useLiveQuery(db().select({ settings: sportPreference.recordingSettings }).from(sportPreference).where(eq(sportPreference.sport, sport)), [sport]);
  return data[0]?.settings ?? defaultRecordingSettings(profile);
}

/** `DAT-003`, `REC-030`, `REC-075`, `SPT-005`: live screen, automatic pause and laps, alerts and heart-rate source of one sport. */
export function SportSettingsScreen({ sport }: SportSettingsScreenProps) {
  const profile = useMemo(() => resolveProfile(sport, {}), [sport]);
  if (profile === null) {
    return (
      <Screen>
        <AppBar title={sports[sport].label} variant="context" leading={<BackButton />} />
        <Text variant="body" tone="secondary">
          Ce sport se note à la main, sans enregistrement GPS.
        </Text>
      </Screen>
    );
  }
  return <RecordingSettingsForm profile={profile} />;
}

interface RecordingSettingsFormProps {
  readonly profile: ResolvedProfile;
}

function RecordingSettingsForm({ profile }: RecordingSettingsFormProps) {
  const sport = profile.sport;
  const label = sports[sport].label;
  const current = useSportSettings(sport, profile);
  const maxHeartRate = maxHeartRateOf(usePhysiology(), environment.now());
  const [sheet, setSheet] = useState<OpenSheet>(null);
  const readout = liveReadout(profile, current);
  const { paceRange, heartRateRange } = current.alerts;
  const heartRate = profile.metrics.includes("heart_rate");
  const alerts = heartRate ? recordingAlerts : recordingAlerts.filter((alert) => alert !== "sensor");

  const save = (summary: string, next: RecordingSettings): void => {
    write(`${summary} : ${label.toLowerCase()}`, [recordingSettingsMutation(db(), sport, next)]);
  };

  const saveReadout = (next: Readout | null): void => {
    const stored = next === null ? null : storedReadout(profile, current, next);
    save("Écran de direct", { ...current, readout: stored === null ? null : { main: stored.main, secondary: [...stored.secondary] } });
  };

  const savePaceRange = (range: PaceRange | null): void => save("Cible d'allure", { ...current, alerts: { ...current.alerts, paceRange: range } });
  const saveHeartRateRange = (range: HeartRateRange | null): void => save("Cible cardio", { ...current, alerts: { ...current.alerts, heartRateRange: range } });

  return (
    <>
      <Screen>
        <AppBar title={`Enregistrement · ${label}`} variant="context" leading={<BackButton />} />

        <ReadoutEditor profile={profile} readout={readout} customized={current.readout !== null} onChange={saveReadout} onReset={() => saveReadout(null)} />

        <Section title="Pendant la sortie">
          <SwitchRow title="Pause automatique" detail="Quand tu t'arrêtes" value={current.autoPause} onChange={(value) => save("Pause automatique", { ...current, autoPause: value })} />
          <Row title="Tours automatiques" detail={autoLapLabel(current.autoLap)} trailing={<Chevron />} onPress={() => setSheet("auto_lap")} last={!heartRate} />
          {heartRate ? (
            <Row
              title="Capteur cardiaque"
              detail={current.heartRateDevice === null ? "Aucun · montre en diffusion ou ceinture" : current.heartRateDevice.name}
              trailing={<Chevron />}
              onPress={() => router.push({ pathname: "/settings/heart-rate/[sport]", params: { sport } })}
              last
            />
          ) : null}
        </Section>

        <Section title="Alertes">
          {alerts.map((alert) => {
            const text = alertLabel(alert, profile);
            return (
              <SwitchRow
                key={alert}
                title={text.title}
                detail={text.detail}
                value={!current.alerts.disabled.includes(alert)}
                onChange={(value) => save(`Alerte ${text.title.toLowerCase()}`, withAlert(current, alert, value))}
              />
            );
          })}
          <SwitchRow
            title="Signal sonore"
            detail="Un bip bref, la musique baisse un instant"
            value={current.alerts.sound}
            onChange={(value) => save("Signal sonore", { ...current, alerts: { ...current.alerts, sound: value } })}
          />
          <Row
            title={profile.primary === "pace" ? "Cible d'allure" : "Cible de vitesse"}
            detail={paceRangeLabel(paceRange, profile)}
            trailing={<Chevron />}
            onPress={() => setSheet("pace")}
            last={!heartRate}
          />
          {heartRate ? (
            <Row
              title="Cible cardio"
              detail={maxHeartRate === null ? "Renseigne ta FC max ou ton année de naissance" : heartRateRangeLabel(heartRateRange)}
              trailing={<Chevron />}
              onPress={() => (maxHeartRate === null ? router.push("/settings/physiology") : setSheet("heart_rate"))}
              last
            />
          ) : null}
        </Section>

        <Section title="Unités">
          <Row title="Système métrique" detail={profile.primary === "pace" ? `Distance en km, allure en min${paceUnit(profile)}, altitude en m` : "Distance en km, vitesse en km/h, altitude en m"} last />
        </Section>
      </Screen>

      <Sheet open={sheet === "auto_lap"} title="Tours automatiques" context="Un tour démarre seul à chaque distance ou durée" onClose={() => setSheet(null)}>
        <Choices
          items={autoLapOptions.map((option) => ({ value: option.value, label: option.label, selected: option.value === autoLapChoiceOf(current.autoLap) }))}
          onChoose={(value) => {
            const option = autoLapOptions.find((item) => item.value === value);
            setSheet(null);
            if (option !== undefined) save("Tours automatiques", { ...current, autoLap: option.autoLap });
          }}
        />
      </Sheet>

      <Sheet open={sheet === "pace"} title={profile.primary === "pace" ? "Cible d'allure" : "Cible de vitesse"} context="Trois vibrations courtes quand tu en sors plus de 8 s" onClose={() => setSheet(null)}>
        <PaceRangeEditor range={paceRange ?? defaultPaceRange(profile)} profile={profile} active={paceRange !== null} onChange={savePaceRange} onClear={() => savePaceRange(null)} />
      </Sheet>

      <Sheet open={sheet === "heart_rate"} title="Cible cardio" context="Zones calculées sur ta FC max" onClose={() => setSheet(null)}>
        <HeartRateRangeEditor range={heartRateRange ?? { lowest: 2, highest: 2 }} active={heartRateRange !== null} maxHeartRate={maxHeartRate} onChange={saveHeartRateRange} onClear={() => saveHeartRateRange(null)} />
      </Sheet>
    </>
  );
}

interface PaceRangeEditorProps {
  readonly range: PaceRange;
  readonly profile: Pick<ResolvedProfile, "pacePerMeters">;
  readonly active: boolean;
  readonly onChange: (range: PaceRange) => void;
  readonly onClear: () => void;
}

function PaceRangeEditor({ range, profile, active, onChange, onClear }: PaceRangeEditorProps) {
  switch (range.kind) {
    case "pace": {
      const scale = profile.pacePerMeters / 1000;
      const bounds = paceBoundsOf(profile);
      const fastest = Math.round(range.fastestSecondsPerKm * scale);
      const slowest = Math.round(range.slowestSecondsPerKm * scale);
      return (
        <View style={styles.editor}>
          <Text variant="label" tone="secondary">
            Plus rapide
          </Text>
          <Stepper
            value={fastest}
            step={paceStepSeconds}
            min={bounds.min}
            max={slowest - paceStepSeconds}
            unit={paceUnit(profile)}
            label="Allure la plus rapide"
            format={formatClock}
            onChange={(value) => onChange({ ...range, fastestSecondsPerKm: Math.round(value / scale) })}
          />
          <Text variant="label" tone="secondary">
            Plus lente
          </Text>
          <Stepper
            value={slowest}
            step={paceStepSeconds}
            min={fastest + paceStepSeconds}
            max={bounds.max}
            unit={paceUnit(profile)}
            label="Allure la plus lente"
            format={formatClock}
            onChange={(value) => onChange({ ...range, slowestSecondsPerKm: Math.round(value / scale) })}
          />
          <RangeFooter active={active} onEnable={() => onChange(range)} onClear={onClear} />
        </View>
      );
    }
    case "speed": {
      const low = mmSToKmhTenths(range.minMmS);
      const high = mmSToKmhTenths(range.maxMmS);
      return (
        <View style={styles.editor}>
          <Text variant="label" tone="secondary">
            Au moins
          </Text>
          <Stepper
            value={low}
            step={speedStepKmhTenths}
            min={speedBoundsKmhTenths.min}
            max={high - speedStepKmhTenths}
            unit="km/h"
            label="Vitesse la plus basse"
            format={formatKmhTenths}
            onChange={(value) => onChange({ ...range, minMmS: kmhTenthsToMmS(value) })}
          />
          <Text variant="label" tone="secondary">
            Au plus
          </Text>
          <Stepper
            value={high}
            step={speedStepKmhTenths}
            min={low + speedStepKmhTenths}
            max={speedBoundsKmhTenths.max}
            unit="km/h"
            label="Vitesse la plus haute"
            format={formatKmhTenths}
            onChange={(value) => onChange({ ...range, maxMmS: kmhTenthsToMmS(value) })}
          />
          <RangeFooter active={active} onEnable={() => onChange(range)} onClear={onClear} />
        </View>
      );
    }
    default: {
      const unreachable: never = range;
      return unreachable;
    }
  }
}

const zoneOptions = heartRateZoneKeys.map((zone) => ({ value: String(zone) as `${HeartRateZone}`, label: `Z${zone}` }));

function zoneOf(value: `${HeartRateZone}`): HeartRateZone {
  return Number(value) as HeartRateZone;
}

interface HeartRateRangeEditorProps {
  readonly range: HeartRateRange;
  readonly active: boolean;
  readonly maxHeartRate: number | null;
  readonly onChange: (range: HeartRateRange) => void;
  readonly onClear: () => void;
}

function HeartRateRangeEditor({ range, active, maxHeartRate, onChange, onClear }: HeartRateRangeEditorProps) {
  const bpm = heartRateSpanBpm(range, maxHeartRate);
  return (
    <View style={styles.editor}>
      <Text variant="label" tone="secondary">
        De
      </Text>
      <Segmented options={zoneOptions} value={`${range.lowest}`} onChange={(value) => onChange(withZoneEnd(range, "lowest", zoneOf(value)))} />
      <Text variant="label" tone="secondary">
        À
      </Text>
      <Segmented options={zoneOptions} value={`${range.highest}`} onChange={(value) => onChange(withZoneEnd(range, "highest", zoneOf(value)))} />
      {bpm === null ? null : (
        <Text variant="small" tone="secondary">
          {bpm}
        </Text>
      )}
      <RangeFooter active={active} onEnable={() => onChange(range)} onClear={onClear} />
    </View>
  );
}

interface RangeFooterProps {
  readonly active: boolean;
  readonly onEnable: () => void;
  readonly onClear: () => void;
}

function RangeFooter({ active, onEnable, onClear }: RangeFooterProps) {
  return active ? <LinkButton label="Ne plus surveiller" onPress={onClear} style={styles.footer} /> : <LinkButton label="Surveiller cette cible" onPress={onEnable} style={styles.footer} />;
}

const styles = StyleSheet.create({
  editor: { gap: 10, paddingBottom: 8 },
  footer: { alignSelf: "center", marginTop: 6 },
});
