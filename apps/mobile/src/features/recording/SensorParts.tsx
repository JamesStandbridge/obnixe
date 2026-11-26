import { useEffect } from "react";
import { StyleSheet, View } from "react-native";
import { router } from "expo-router";
import type { ResolvedProfile, SensorRole } from "@obnixe/core";
import type { SensorDeviceChoice } from "@obnixe/schema";
import { sensorTextsOf } from "@/features/recording/sensorTexts";
import { sensorServiceOf } from "@/features/tracking/sensorDevices";
import { useSensorScan } from "@/features/tracking/sensorScan";
import { LinkButton } from "@/ui/Button";
import { Icon } from "@/ui/icons/Icon";
import type { IconName } from "@/ui/icons/Icon";
import { BevelView } from "@/ui/Shapes";
import { Text } from "@/ui/Text";
import { useTheme } from "@/ui/theme";
import { bevels } from "@/ui/tokens";

export const sensorIcons: Readonly<Record<SensorRole, IconName>> = { heart_rate: "heart", cadence: "cadence", power: "power" };

/** The Garmin menu path of `SPT-007` and the watch battery note of `PRF-004`. */
export function BroadcastHelp() {
  return (
    <View style={styles.help}>
      <Text variant="bodyStrong">Diffuser depuis ta montre</Text>
      <Text variant="small" tone="secondary">
        Garmin (Venu 3S, Forerunner, Fenix) : maintiens le bouton du bas, puis Paramètres › Santé et bien-être › FC au poignet › Diffuser la fréquence cardiaque. Selon le modèle, le menu des commandes propose aussi Diffuser la FC.
      </Text>
      <Text variant="small" tone="secondary">
        Une ceinture cardio se réveille dès qu'elle touche la peau humide.
      </Text>
      <Text variant="small" tone="secondary">
        La diffusion vide plus vite la batterie de la montre : arrête-la après la sortie.
      </Text>
    </View>
  );
}

interface SensorHelpProps {
  readonly role: SensorRole;
  readonly profile: Pick<ResolvedProfile, "cadence">;
}

export function SensorHelp({ role, profile }: SensorHelpProps) {
  if (role === "heart_rate") return <BroadcastHelp />;
  return (
    <View style={styles.help}>
      {sensorTextsOf(role, profile).help.map((line) => (
        <Text key={line} variant="small" tone="secondary">
          {line}
        </Text>
      ))}
    </View>
  );
}

const visibilityScanMs = 8000;

interface SensorCardProps {
  readonly role: SensorRole;
  readonly profile: ResolvedProfile;
  readonly device: SensorDeviceChoice | null;
}

/** `SPT-007`, `SPT-008`: the memorized source on the preparation screen, seen advertising or not; it connects at the start. */
export function SensorCard({ role, profile, device }: SensorCardProps) {
  const { colors } = useTheme();
  const { devices, scanned, scan } = useSensorScan(sensorServiceOf(role, profile), visibilityScanMs, false);
  const texts = sensorTextsOf(role, profile);
  const deviceId = device?.id ?? null;
  useEffect(() => {
    if (deviceId !== null) scan();
  }, [deviceId, scan]);

  const pair = (): void => router.push({ pathname: "/settings/sensor/[role]/[sport]", params: { role, sport: profile.sport } });
  if (device === null) {
    return (
      <View style={styles.row}>
        <Icon name={sensorIcons[role]} size={20} color={colors.text2} />
        <Text variant="small" tone="secondary" style={styles.rowText}>
          Pas de {texts.title.toLowerCase()} pour ce sport
        </Text>
        <LinkButton label="Connecter" onPress={pair} />
      </View>
    );
  }
  const seen = devices.some((item) => item.id === device.id);
  const missing = scanned && !seen;
  const title = seen ? `${device.name} visible` : missing ? `${device.name} introuvable` : device.name;
  const detail = seen ? texts.seen : missing ? texts.missing : "Se connecte au démarrage de la sortie";
  const tone = seen ? colors.mark : missing ? colors.warn : colors.text3;
  return (
    <BevelView fill={colors.surface} cut={bevels.card} band={{ color: tone, height: 4 }} style={styles.card}>
      <View style={styles.cardHead} accessible accessibilityLiveRegion="polite" accessibilityLabel={`${title}. ${detail}`}>
        <Icon name={sensorIcons[role]} size={22} color={tone} />
        <View style={styles.rowText}>
          <Text variant="heading">{title}</Text>
          <Text variant="small" tone="secondary">
            {detail}
          </Text>
        </View>
        <LinkButton label="Changer" onPress={pair} />
      </View>
      {missing ? <SensorHelp role={role} profile={profile} /> : null}
    </BevelView>
  );
}

const styles = StyleSheet.create({
  help: { gap: 6 },
  row: { flexDirection: "row", alignItems: "center", gap: 10, marginTop: 12, minHeight: 44 },
  rowText: { flex: 1, minWidth: 0, gap: 2 },
  card: { marginTop: 12, padding: 16, paddingTop: 18, gap: 12 },
  cardHead: { flexDirection: "row", alignItems: "center", gap: 12 },
});
