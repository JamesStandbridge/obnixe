import { useEffect, useState } from "react";
import { StyleSheet, View } from "react-native";
import Svg, { Path } from "react-native-svg";
import Constants from "expo-constants";
import { router } from "expo-router";
import { useLiveQuery } from "drizzle-orm/expo-sqlite";
import { enabledSports, weekdaysOf } from "@obnixe/core";
import { settings, sportPreference, sports, zones } from "@obnixe/schema";
import type { Theme } from "@obnixe/schema";
import { db } from "@/data/database";
import { ExportArchiveSheet } from "@/features/activityFiles/ExportArchiveSheet";
import { AsideSheet, useAsideCopies } from "@/features/data/AsideSheet";
import { BackupPanel } from "@/features/data/BackupPanel";
import { storageBytes } from "@/features/data/files";
import { megabytes, weekdayList } from "@/features/data/format";
import { formatTimeOfDay } from "@/format/dates";
import { BackButton, Chevron } from "@/features/data/parts";
import { MapSettingsSection } from "@/features/maps/MapSettingsSection";
import { MassUnitSheet, RemindersSheet, massUnitLabels } from "@/features/data/PreferenceSheets";
import { RestAlertsRow } from "@/features/data/RestAlertsRow";
import { PrivacySettingsSection } from "@/features/privacy/PrivacySettingsSection";
import { RecordingSettingsSection } from "@/features/recording/RecordingSettingsSection";
import { updateSettings } from "@/data/settings";
import { SportsSheet } from "@/features/data/SportsSheet";
import { TrashSheet, useTrash } from "@/features/data/TrashSheet";
import { ZonesSheet, useTrackedZones } from "@/features/data/ZonesSheet";
import { Segmented } from "@/ui/Controls";
import { LogoMark } from "@/ui/illustrations/scenes";
import { AppBar, Row, Screen, Section } from "@/ui/Layout";
import { bevelPath } from "@/ui/Shapes";
import { Text } from "@/ui/Text";
import { useTheme } from "@/ui/theme";
import { fonts } from "@/ui/tokens";

type OpenSheet = "sports" | "zones" | "unit" | "reminders" | "trash" | "aside" | "exportArchive" | null;

const themeOptions: readonly { readonly value: Theme; readonly label: string }[] = [
  { value: "dark", label: "Sombre" },
  { value: "sunlight", label: "Plein soleil" },
  { value: "system", label: "Système" },
];

function useStorageBytes(): number | null {
  const [bytes, setBytes] = useState<number | null>(null);
  useEffect(() => {
    let active = true;
    void storageBytes().then((value) => {
      if (active) setBytes(value);
    });
    return () => {
      active = false;
    };
  }, []);
  return bytes;
}

const version = Constants.expoConfig?.version ?? "";

export default function Settings() {
  const { colors } = useTheme();
  const [sheet, setSheet] = useState<OpenSheet>(null);
  const { data: settingsRows } = useLiveQuery(db().select().from(settings));
  const { data: preferences } = useLiveQuery(db().select().from(sportPreference));
  const tracked = useTrackedZones();
  const trash = useTrash();
  const bytes = useStorageBytes();
  const aside = useAsideCopies();
  const current = settingsRows[0];
  const shown = enabledSports(preferences);
  const reminderDays = weekdaysOf(current?.reminderWeekdays ?? 0);
  const close = (): void => setSheet(null);

  return (
    <>
      <Screen>
        <AppBar title="Données et réglages" variant="context" leading={<BackButton />} />
        <BackupPanel />

        <Section title="Stockage">
          <Row title="Importer une sauvegarde" trailing={<Chevron />} onPress={() => router.push("/import")} />
          <Row title="Importer une activité" detail="GPX, TCX ou FIT, depuis une montre ou une app" trailing={<Chevron />} onPress={() => router.push("/import-activity")} />
          <Row title="Importer l'archive Garmin Connect" detail="tout l'historique, depuis l'export du compte" trailing={<Chevron />} onPress={() => router.push("/import-archive")} />
          <Row title="Exporter les activités" detail="archive ZIP de fichiers GPX ou FIT" trailing={<Chevron />} onPress={() => setSheet("exportArchive")} />
          <Row title="Corbeille" detail="30 jours" value={String(trash.items.length + trash.replaced.length)} trailing={<Chevron />} onPress={() => setSheet("trash")} />
          {aside.copies.length === 0 ? null : (
            <Row
              title="Copies mises de côté"
              detail="bases illisibles au démarrage"
              value={String(aside.copies.length)}
              trailing={<Chevron />}
              onPress={() => {
                aside.refresh();
                setSheet("aside");
              }}
            />
          )}
          <Row title="Espace utilisé" detail="sur ce téléphone" {...(bytes === null ? {} : { value: megabytes(bytes), valueDetail: "Mo" })} trailing={<View style={styles.chevronSpace} />} />
          <Row
            title="Rappels dans l'agenda"
            {...(current?.remindersExportedAt == null || reminderDays.length === 0 ? {} : { detail: `${weekdayList(reminderDays)} à ${formatTimeOfDay(current.reminderMinutes)}` })}
            trailing={<Chevron />}
            onPress={() => setSheet("reminders")}
            last
          />
        </Section>

        <Section title="Suivi">
          <Row
            title="Sports"
            detail={shown.length === 0 ? "aucun" : shown.map((sport) => sports[sport].label).join(", ")}
            value={String(shown.length)}
            trailing={<Chevron />}
            onPress={() => setSheet("sports")}
          />
          <Row
            title="Zones suivies"
            detail={tracked.length === 0 ? "aucune" : tracked.map((row) => zones[row.zone].label.toLowerCase()).join(", ")}
            value={String(tracked.length)}
            trailing={<Chevron />}
            onPress={() => setSheet("zones")}
            last
          />
        </Section>

        <Section title="Séances">
          <RestAlertsRow />
        </Section>

        <RecordingSettingsSection preferences={preferences} />

        <Section title="Affichage">
          <View style={styles.theme} accessibilityLabel="Thème">
            <Segmented options={themeOptions} value={current?.theme ?? "dark"} onChange={(theme) => updateSettings({ theme })} />
          </View>
        </Section>

        <MapSettingsSection cacheMegabytes={current?.mapCacheMegabytes ?? 200} />

        <PrivacySettingsSection hideTrackEndsMeters={current?.hideTrackEndsMeters ?? 0} exportPrivacy={current?.exportPrivacy ?? true} maskInApp={current?.maskInApp ?? false} weatherEnabled={current?.weatherEnabled ?? true} />

        <Section title="Unités">
          <Row
            title="Charges et poids"
            trailing={
              <View style={styles.unit}>
                <Text variant="label" tone="secondary">
                  {massUnitLabels[current?.massUnit ?? "kg"]}
                </Text>
                <Chevron />
              </View>
            }
            onPress={() => setSheet("unit")}
            last
          />
        </Section>

        <View style={styles.signature} accessible accessibilityLabel={`Obnixe ${version}`}>
          <Svg width={28} height={28} viewBox="0 0 1024 1024">
            <Path d={bevelPath(1024, 1024, 220, 160, "topRight")} fill={colors.brand} />
            <LogoMark ink={colors.brandInk} accent={colors.brandDeep} />
          </Svg>
          <Text style={styles.signatureName}>Obnixe</Text>
          <Text variant="caption" tone="tertiary">
            {version}
          </Text>
        </View>
      </Screen>

      <SportsSheet open={sheet === "sports"} onClose={close} />
      <ZonesSheet open={sheet === "zones"} onClose={close} />
      <MassUnitSheet open={sheet === "unit"} value={current?.massUnit ?? "kg"} onClose={close} />
      <RemindersSheet open={sheet === "reminders"} weekdays={current?.reminderWeekdays ?? 0} minutes={current?.reminderMinutes ?? 18 * 60 + 30} onClose={close} />
      <ExportArchiveSheet open={sheet === "exportArchive"} onClose={close} />
      <TrashSheet open={sheet === "trash"} massUnit={current?.massUnit ?? "kg"} onClose={close} />
      <AsideSheet open={sheet === "aside"} aside={aside} onClose={close} />
    </>
  );
}

const styles = StyleSheet.create({
  theme: { marginTop: 10 },
  unit: { flexDirection: "row", alignItems: "center", gap: 12 },
  chevronSpace: { width: 16 },
  signature: { marginTop: 40, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8 },
  signatureName: { fontFamily: fonts.brand800, fontSize: 16, letterSpacing: 0.4 },
});
