import { useMemo } from "react";
import { Linking, Platform, StyleSheet, View } from "react-native";
import { router } from "expo-router";
import { BackButton } from "@/features/data/parts";
import { batteryGuide, batteryVendorOf } from "@/features/tracking/battery";
import type { BatteryGuide } from "@/features/tracking/battery";
import { openSystemSettings } from "@/features/tracking/permissions";
import { ControlButton, LinkButton, PrimaryButton } from "@/ui/Button";
import { AppBar, Screen, Section } from "@/ui/Layout";
import { Text } from "@/ui/Text";
import { useTheme } from "@/ui/theme";

const batteryOptimizationSettings = "android.settings.IGNORE_BATTERY_OPTIMIZATION_SETTINGS";

export function deviceBatteryGuide(): BatteryGuide {
  return batteryGuide(Platform.OS === "android" ? batteryVendorOf(Platform.constants.Manufacturer, "android") : batteryVendorOf(null, "ios"));
}

function openBatteryOptimization(): void {
  Linking.sendIntent(batteryOptimizationSettings).catch(openSystemSettings);
}

/** `PLT-011`: before the first recording on a system known to stop background services. */
export function BatteryHint() {
  const { colors } = useTheme();
  const guide = useMemo(deviceBatteryGuide, []);
  if (!guide.aggressive) return null;
  return (
    <View style={[styles.hint, { borderColor: colors.line }]}>
      <Text variant="small" tone="secondary" style={styles.hintText}>
        {`Sur ${guide.brand}, autorise Obnixe en arrière-plan pour que la sortie ne s'arrête pas écran éteint.`}
      </Text>
      <LinkButton label="Voir comment" onPress={() => router.push("/settings/battery")} />
    </View>
  );
}

/** `PLT-011`: how to keep the phone from stopping a recording in the background. */
export function BatteryHelpScreen() {
  const { colors } = useTheme();
  const guide = useMemo(deviceBatteryGuide, []);
  return (
    <Screen>
      <AppBar title="Batterie et arrière-plan" variant="context" leading={<BackButton />} />
      <Text variant="body" tone="secondary" style={styles.intro}>
        {guide.aggressive
          ? `Les téléphones ${guide.brand} ferment souvent les applications en arrière-plan pour économiser la batterie, même pendant une sortie. Ces réglages évitent les coupures.`
          : "Obnixe enregistre écran éteint. Ces réglages évitent que le système ne l'arrête pendant une longue sortie."}
      </Text>

      <Section title={guide.brand}>
        <View style={styles.steps}>
          {guide.steps.map((step, index) => (
            <View key={step} style={styles.step}>
              <Text variant="label" style={[styles.stepIndex, { color: colors.text2 }]}>
                {index + 1}
              </Text>
              <Text variant="body" style={styles.stepText}>
                {step}
              </Text>
            </View>
          ))}
        </View>
      </Section>

      <View style={styles.actions}>
        <PrimaryButton label="Ouvrir les réglages d'Obnixe" onPress={openSystemSettings} />
        {Platform.OS === "android" ? <ControlButton label="Optimisation de la batterie" onPress={openBatteryOptimization} /> : null}
      </View>

      <Text variant="small" tone="secondary" style={styles.note}>
        Si une sortie s'interrompt quand même, ce qui a été mesuré reste conservé et tu peux la reprendre.
      </Text>
    </Screen>
  );
}

const styles = StyleSheet.create({
  intro: { marginTop: 8 },
  steps: { gap: 14, marginTop: 8 },
  step: { flexDirection: "row", gap: 12 },
  stepIndex: { width: 18, textAlign: "right" },
  stepText: { flex: 1, minWidth: 0 },
  actions: { gap: 10, marginTop: 28 },
  note: { marginTop: 16 },
  hint: { flexDirection: "row", alignItems: "center", gap: 12, marginTop: 12, paddingVertical: 10, borderTopWidth: 1, borderBottomWidth: 1 },
  hintText: { flex: 1, minWidth: 0 },
});
