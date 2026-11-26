import { useMemo } from "react";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import { useLiveQuery } from "drizzle-orm/expo-sqlite";
import { pairedSensorOf, recordingSettingsMutation, recordingSettingsOf, resolveProfile, sensorRolesOf, withSensorDevice } from "@obnixe/core";
import type { ResolvedProfile, SensorRole } from "@obnixe/core";
import { sportPreference, sports } from "@obnixe/schema";
import type { SensorDeviceChoice, SportKey } from "@obnixe/schema";
import { db } from "@/data/database";
import { write } from "@/data/write";
import { BackButton } from "@/features/data/parts";
import { recordableSports } from "@/features/recording/queries";
import { SensorHelp } from "@/features/recording/SensorParts";
import { sensorTextsOf } from "@/features/recording/sensorTexts";
import { sensorServiceOf, signalStrengthOf } from "@/features/tracking/sensorDevices";
import type { SignalStrength } from "@/features/tracking/sensorDevices";
import { useSensorScan } from "@/features/tracking/sensorScan";
import type { SensorScanStatus } from "@/features/tracking/sensorScan";
import { openSystemSettings } from "@/features/tracking/permissions";
import { ControlButton, LinkButton, PrimaryButton } from "@/ui/Button";
import { MenuItem } from "@/ui/Inputs";
import { AppBar, Screen, Section } from "@/ui/Layout";
import { BevelView } from "@/ui/Shapes";
import { useSnackbar } from "@/ui/SnackbarHost";
import { Text } from "@/ui/Text";
import { useTheme } from "@/ui/theme";
import { bevels } from "@/ui/tokens";
import type { SensorDevice } from "../../../modules/obnixe-tracker";

const pairingScanMs = 20_000;

const strengthLabels: Readonly<Record<SignalStrength, string>> = { strong: "Signal fort", medium: "Signal moyen", weak: "Signal faible, rapproche-toi" };

function statusNote(status: SensorScanStatus): string | null {
  switch (status) {
    case "idle":
    case "scanning":
      return null;
    case "denied":
      return "Bluetooth refusé : autorise-le dans les réglages du téléphone pour trouver tes capteurs.";
    case "unavailable":
      return "Le Bluetooth est coupé : active-le puis relance la recherche.";
    case "unsupported":
      return "La recherche de capteurs se fait depuis l'application mobile.";
    case "failed":
      return "La recherche a échoué, réessaie.";
    default: {
      const unreachable: never = status;
      return unreachable;
    }
  }
}

interface SensorSourceScreenProps {
  readonly role: SensorRole;
  readonly sport: SportKey;
}

/** `SPT-007`, `SPT-008`, `PRV-006`: finds, memorizes for the sport and forgets one Bluetooth source; it connects at each recording start. */
export function SensorSourceScreen({ role, sport }: SensorSourceScreenProps) {
  const profile = useMemo(() => resolveProfile(sport, {}), [sport]);
  if (profile === null || !sensorRolesOf(profile).includes(role)) {
    return (
      <Screen>
        <AppBar title={profile === null ? "Capteur" : sensorTextsOf(role, profile).title} variant="context" leading={<BackButton />} />
        <Text variant="body" tone="secondary">
          {profile === null ? "Ce sport se note à la main, sans enregistrement." : "Ce sport ne prend pas ce capteur."}
        </Text>
      </Screen>
    );
  }
  return <SourcePicker role={role} profile={profile} />;
}

interface SourcePickerProps {
  readonly role: SensorRole;
  readonly profile: ResolvedProfile;
}

function SourcePicker({ role, profile }: SourcePickerProps) {
  const { colors } = useTheme();
  const notify = useSnackbar();
  const sport = profile.sport;
  const label = sports[sport].label;
  const texts = sensorTextsOf(role, profile);
  const service = sensorServiceOf(role, profile);
  const memorized = texts.feminine ? "mémorisée" : "mémorisé";
  const { data: preferences } = useLiveQuery(db().select().from(sportPreference));
  const settings = useMemo(() => recordingSettingsOf(db(), profile), [profile, preferences]);
  const others = useMemo(
    () =>
      recordableSports(preferences).flatMap((key) => {
        const other = key === sport ? null : resolveProfile(key, {});
        return other !== null && sensorRolesOf(other).includes(role) && sensorServiceOf(role, other) === service ? [other] : [];
      }),
    [preferences, sport, role, service],
  );
  const { status, devices, scanned, scan } = useSensorScan(service, pairingScanMs, true);
  const paired = pairedSensorOf(profile, settings, role);
  const note = statusNote(status);

  const choose = (device: SensorDeviceChoice | null): void => {
    write(device === null ? `${texts.title} oublié : ${label.toLowerCase()}` : `${texts.title} ${device.name} : ${label.toLowerCase()}`, [recordingSettingsMutation(db(), sport, withSensorDevice(settings, role, device))]);
  };

  const pair = (device: SensorDevice): void => {
    const name = device.name.trim() === "" ? texts.title : device.name.trim();
    choose({ id: device.id, name });
    notify({ text: `${name} ${memorized} pour ${label.toLowerCase()}` });
  };

  const shareWithAll = (device: SensorDeviceChoice): void => {
    const mutations = others.map((other) => recordingSettingsMutation(db(), other.sport, withSensorDevice(recordingSettingsOf(db(), other), role, device)));
    if (mutations.length === 0) return;
    write(`${texts.title} ${device.name} : tous les sports`, mutations);
    notify({ text: `${device.name} ${memorized} pour tous tes sports` });
  };

  return (
    <Screen>
      <AppBar title={`${texts.title} · ${label}`} variant="context" leading={<BackButton />} />

      {paired === null ? (
        <Text variant="body" tone="secondary" style={styles.intro}>
          {texts.intro}
        </Text>
      ) : (
        <BevelView fill={colors.surface} cut={bevels.card} band={{ color: colors.mark, height: 4 }} style={styles.paired}>
          <Text variant="eyebrow" tone="secondary">
            Mémorisé pour {label.toLowerCase()}
          </Text>
          <Text variant="title">{paired.name}</Text>
          <Text variant="small" tone="secondary">
            {texts.paired}
          </Text>
          <View style={styles.pairedActions}>
            {others.length === 0 ? null : <ControlButton label="Pour tous mes sports" onPress={() => shareWithAll(paired)} />}
            <LinkButton label="Oublier" onPress={() => choose(null)} />
          </View>
        </BevelView>
      )}

      <Section title="Sources à proximité">
        {status === "scanning" ? (
          <View style={styles.scanning} accessibilityLiveRegion="polite">
            <ActivityIndicator color={colors.text2} />
            <Text variant="small" tone="secondary">
              Recherche des sources qui diffusent…
            </Text>
          </View>
        ) : (
          <PrimaryButton label={devices.length === 0 ? "Rechercher" : "Relancer la recherche"} onPress={scan} />
        )}
        {note === null ? null : (
          <View style={styles.note}>
            <Text variant="small" tone="secondary">
              {note}
            </Text>
            {status === "denied" ? <LinkButton label="Ouvrir les réglages" onPress={openSystemSettings} /> : null}
          </View>
        )}
        {devices.map((device) => (
          <MenuItem
            key={device.id}
            label={device.name.trim() === "" ? "Capteur sans nom" : device.name}
            detail={paired?.id === device.id ? "Mémorisé" : strengthLabels[signalStrengthOf(device.rssi)]}
            onPress={() => pair(device)}
          />
        ))}
        {scanned && status === "idle" && devices.length === 0 ? (
          <Text variant="small" tone="secondary" style={styles.empty}>
            Aucune source trouvée pour l'instant.
          </Text>
        ) : null}
      </Section>

      <Section title="Aide">
        <SensorHelp role={role} profile={profile} />
      </Section>
    </Screen>
  );
}

const styles = StyleSheet.create({
  intro: { marginTop: 8 },
  paired: { marginTop: 12, padding: 16, paddingTop: 18, gap: 6 },
  pairedActions: { flexDirection: "row", alignItems: "center", gap: 12, marginTop: 8 },
  scanning: { flexDirection: "row", alignItems: "center", gap: 10, minHeight: 52 },
  note: { gap: 4, marginTop: 8 },
  empty: { marginTop: 10 },
});
