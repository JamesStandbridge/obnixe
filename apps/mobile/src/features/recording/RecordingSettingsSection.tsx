import { router } from "expo-router";
import { defaultRecordingSettings, resolveProfile } from "@obnixe/core";
import { sports } from "@obnixe/schema";
import type { SportPreference } from "@obnixe/schema";
import { environment } from "@/data/database";
import { usePhysiology } from "@/data/settings";
import { Chevron } from "@/features/data/parts";
import { maxHeartRateFrom } from "@/features/recording/physiology";
import { recordableSports } from "@/features/recording/queries";
import { settingsSummary } from "@/features/recording/settings";
import { Row, Section } from "@/ui/Layout";

interface RecordingSettingsSectionProps {
  readonly preferences: readonly SportPreference[];
}

/** `DAT-003`: one entry per recordable sport, then what every recording shares. */
export function RecordingSettingsSection({ preferences }: RecordingSettingsSectionProps) {
  const max = maxHeartRateFrom(usePhysiology(), environment.now());
  return (
    <Section title="Enregistrement">
      {recordableSports(preferences).map((sport) => {
        const profile = resolveProfile(sport, {});
        if (profile === null) return null;
        const stored = preferences.find((preference) => preference.sport === sport)?.recordingSettings ?? null;
        return (
          <Row
            key={sport}
            title={sports[sport].label}
            detail={settingsSummary(stored ?? defaultRecordingSettings(profile))}
            trailing={<Chevron />}
            onPress={() => router.push({ pathname: "/settings/recording/[sport]", params: { sport } })}
          />
        );
      })}
      <Row
        title="Profil physiologique"
        detail={max.kind === "unknown" ? "FC max, année de naissance" : `FC max ${max.bpm} bpm`}
        trailing={<Chevron />}
        onPress={() => router.push("/settings/physiology")}
      />
      <Row title="Batterie et arrière-plan" detail="Pour que rien ne coupe la sortie" trailing={<Chevron />} onPress={() => router.push("/settings/battery")} last />
    </Section>
  );
}
