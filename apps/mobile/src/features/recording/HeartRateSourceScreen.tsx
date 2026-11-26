import { useMemo } from "react";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import { useLiveQuery } from "drizzle-orm/expo-sqlite";
import { recordingSettingsMutation, recordingSettingsOf, resolveProfile } from "@obnixe/core";
import type { ResolvedProfile } from "@obnixe/core";
import { sportPreference, sports } from "@obnixe/schema";
import type { HeartRateDeviceChoice, SportKey } from "@obnixe/schema";
import { db } from "@/data/database";
import { write } from "@/data/write";
import { BackButton } from "@/features/data/parts";
import { BroadcastHelp } from "@/features/recording/HeartRateParts";
import { recordableSports } from "@/features/recording/queries";
import { signalStrengthOf } from "@/features/tracking/heartRateDevices";
import type { SignalStrength } from "@/features/tracking/heartRateDevices";
import { useHeartRateScan } from "@/features/tracking/heartRateScan";
import type { HeartRateScanStatus } from "@/features/tracking/heartRateScan";
import { openSystemSettings } from "@/features/tracking/permissions";
import { ControlButton, LinkButton, PrimaryButton } from "@/ui/Button";
import { MenuItem } from "@/ui/Inputs";
import { AppBar, Screen, Section } from "@/ui/Layout";
import { BevelView } from "@/ui/Shapes";
import { useSnackbar } from "@/ui/SnackbarHost";
import { Text } from "@/ui/Text";
import { useTheme } from "@/ui/theme";
import { bevels } from "@/ui/tokens";
import type { HeartRateDevice } from "../../../modules/obnixe-tracker";

const pairingScanMs = 20_000;

const strengthLabels: Readonly<Record<SignalStrength, string>> = { strong: "Signal fort", medium: "Signal moyen", weak: "Signal faible, rapproche-la" };

function statusNote(status: HeartRateScanStatus): string | null {
  switch (status) {
    case "idle":
    case "scanning":
      return null;
    case "denied":
      return "Bluetooth refusé : autorise-le dans les réglages du téléphone pour trouver ta montre.";
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

interface HeartRateSourceScreenProps {
  readonly sport: SportKey;
}

/** `SPT-007`, `PRV-006`: finds, memorizes for the sport and forgets a Heart Rate source; it connects at each recording start. */
export function HeartRateSourceScreen({ sport }: HeartRateSourceScreenProps) {
  const profile = useMemo(() => resolveProfile(sport, {}), [sport]);
  if (profile === null) {
    return (
      <Screen>
        <AppBar title="Capteur cardiaque" variant="context" leading={<BackButton />} />
        <Text variant="body" tone="secondary">
          Ce sport se note à la main, sans enregistrement.
        </Text>
      </Screen>
    );
  }
  return <SourcePicker profile={profile} />;
}

interface SourcePickerProps {
  readonly profile: ResolvedProfile;
}

function SourcePicker({ profile }: SourcePickerProps) {
  const { colors } = useTheme();
  const notify = useSnackbar();
  const sport = profile.sport;
  const label = sports[sport].label;
  const { data: preferences } = useLiveQuery(db().select().from(sportPreference));
  const settings = useMemo(() => recordingSettingsOf(db(), profile), [profile, preferences]);
  const others = useMemo(() => recordableSports(preferences).filter((key) => key !== sport), [preferences, sport]);
  const { status, devices, scanned, scan } = useHeartRateScan(pairingScanMs, true);
  const paired = settings.heartRateDevice;
  const note = statusNote(status);

  const choose = (device: HeartRateDeviceChoice | null): void => {
    write(device === null ? `Capteur cardiaque oublié : ${label.toLowerCase()}` : `Capteur cardiaque ${device.name} : ${label.toLowerCase()}`, [recordingSettingsMutation(db(), sport, { ...settings, heartRateDevice: device })]);
  };

  const pair = (device: HeartRateDevice): void => {
    const name = device.name.trim() === "" ? "Capteur cardiaque" : device.name.trim();
    choose({ id: device.id, name });
    notify({ text: `${name} mémorisée pour ${label.toLowerCase()}` });
  };

  const shareWithAll = (device: HeartRateDeviceChoice): void => {
    const mutations = others.flatMap((key) => {
      const other = resolveProfile(key, {});
      return other === null ? [] : [recordingSettingsMutation(db(), key, { ...recordingSettingsOf(db(), other), heartRateDevice: device })];
    });
    if (mutations.length === 0) return;
    write(`Capteur cardiaque ${device.name} : tous les sports`, mutations);
    notify({ text: `${device.name} mémorisée pour tous tes sports` });
  };

  return (
    <Screen>
      <AppBar title={`Capteur cardiaque · ${label}`} variant="context" leading={<BackButton />} />

      {paired === null ? (
        <Text variant="body" tone="secondary" style={styles.intro}>
          Montre en diffusion ou ceinture Bluetooth : elle se connecte seule au démarrage de chaque sortie, et se reconnecte si le lien se perd.
        </Text>
      ) : (
        <BevelView fill={colors.surface} cut={bevels.card} band={{ color: colors.mark, height: 4 }} style={styles.paired}>
          <Text variant="eyebrow" tone="secondary">
            Mémorisé pour {label.toLowerCase()}
          </Text>
          <Text variant="title">{paired.name}</Text>
          <Text variant="small" tone="secondary">
            Connecté au démarrage de la sortie, la fréquence cardiaque prend la dernière place de l'écran de direct.
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
        <BroadcastHelp />
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
