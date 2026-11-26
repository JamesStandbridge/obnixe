import { useEffect } from "react";
import { StyleSheet, View } from "react-native";
import { router } from "expo-router";
import type { HeartRateDeviceChoice, SportKey } from "@obnixe/schema";
import { useHeartRateScan } from "@/features/tracking/heartRateScan";
import { LinkButton } from "@/ui/Button";
import { Icon } from "@/ui/icons/Icon";
import { BevelView } from "@/ui/Shapes";
import { Text } from "@/ui/Text";
import { useTheme } from "@/ui/theme";
import { bevels } from "@/ui/tokens";

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

const visibilityScanMs = 8000;

interface HeartRateCardProps {
  readonly sport: SportKey;
  readonly device: HeartRateDeviceChoice | null;
}

/** `SPT-007`: the memorized source on the preparation screen, seen advertising or not; it connects at the start. */
export function HeartRateCard({ sport, device }: HeartRateCardProps) {
  const { colors } = useTheme();
  const { devices, scanned, scan } = useHeartRateScan(visibilityScanMs, false);
  const deviceId = device?.id ?? null;
  useEffect(() => {
    if (deviceId !== null) scan();
  }, [deviceId, scan]);

  const pair = (): void => router.push({ pathname: "/settings/heart-rate/[sport]", params: { sport } });
  if (device === null) {
    return (
      <View style={styles.row}>
        <Icon name="heart" size={20} color={colors.text2} />
        <Text variant="small" tone="secondary" style={styles.rowText}>
          Pas de capteur cardiaque pour ce sport
        </Text>
        <LinkButton label="Connecter" onPress={pair} />
      </View>
    );
  }
  const seen = devices.some((item) => item.id === device.id);
  const missing = scanned && !seen;
  const title = seen ? `${device.name} visible` : missing ? `${device.name} introuvable` : device.name;
  const detail = seen ? "Elle se connecte au démarrage de la sortie" : missing ? "Lance la diffusion : elle se connectera au démarrage" : "Se connecte au démarrage de la sortie";
  const tone = seen ? colors.mark : missing ? colors.warn : colors.text3;
  return (
    <BevelView fill={colors.surface} cut={bevels.card} band={{ color: tone, height: 4 }} style={styles.card}>
      <View style={styles.cardHead} accessible accessibilityLiveRegion="polite" accessibilityLabel={`${title}. ${detail}`}>
        <Icon name="heart" size={22} color={tone} />
        <View style={styles.rowText}>
          <Text variant="heading">{title}</Text>
          <Text variant="small" tone="secondary">
            {detail}
          </Text>
        </View>
        <LinkButton label="Changer" onPress={pair} />
      </View>
      {missing ? <BroadcastHelp /> : null}
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
