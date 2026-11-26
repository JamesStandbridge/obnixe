import { Pressable, StyleSheet, View } from "react-native";
import Animated from "react-native-reanimated";
import { router } from "expo-router";
import { sports } from "@obnixe/schema";
import type { SportKey } from "@obnixe/schema";
import { formatDistance } from "@/features/recording/metrics";
import { recordingAvailable, useRecorderView } from "@/features/tracking/recorder";
import type { RecordingView } from "@/features/tracking/recorderHost";
import { formatLongClock } from "@/format/durations";
import { Icon } from "@/ui/icons/Icon";
import { SportIcon } from "@/ui/icons/SportIcon";
import { usePressScale } from "@/ui/motion";
import { BevelView } from "@/ui/Shapes";
import { StatRow } from "@/ui/Stats";
import type { StatValue } from "@/ui/Stats";
import { Text } from "@/ui/Text";
import { useTheme } from "@/ui/theme";
import { bevels, wash } from "@/ui/tokens";

function phaseWord(recording: RecordingView): string {
  switch (recording.state.phase) {
    case "preparing":
      return "Démarrage";
    case "recording":
      return "En cours";
    case "auto_paused":
      return "Pause auto";
    case "paused":
      return "En pause";
    case "finishing":
      return "À enregistrer";
    case "interrupted":
      return "Interrompue";
    case "saved":
      return "Enregistrée";
    case "discarded":
      return "Supprimée";
    default: {
      const unreachable: never = recording.state;
      return unreachable;
    }
  }
}

/** The figures of the recording in progress on Today, refreshed with the recorder view. */
export function LiveRecordingStats() {
  const view = useRecorderView();
  if (view.kind !== "recording") return null;
  const recording = view.recording;
  const distance = formatDistance(recording.live.distanceMm / 1000);
  const stats: StatValue[] = [
    { label: "Distance", value: distance.value, unit: distance.unit },
    { label: "Temps", value: formatLongClock((recording.clock?.timerMs ?? recording.live.movingMs) / 1000), unit: "" },
    { label: "État", value: phaseWord(recording), unit: "" },
  ];
  return <StatRow stats={stats} />;
}

interface StartRecordingCardProps {
  readonly sport: SportKey;
}

/** `REC-001`: one tap from Today to the preparation screen; on the web, where nothing records, the `PLT-020` message. */
export function StartRecordingCard({ sport }: StartRecordingCardProps) {
  const { colors } = useTheme();
  const press = usePressScale(0.97);
  if (!recordingAvailable) {
    return (
      <View style={[styles.web, { borderColor: colors.line }]}>
        <Icon name="locate" size={18} color={colors.text2} />
        <Text variant="small" tone="secondary" style={styles.webText}>
          Enregistre tes activités depuis l'application mobile
        </Text>
      </View>
    );
  }
  const tone = colors.sport[sport];
  return (
    <Animated.View style={[styles.frame, press.style]}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Enregistrer une sortie, ${sports[sport].label.toLowerCase()} proposée`}
        onPress={() => router.push({ pathname: "/record", params: { sport } })}
        onPressIn={press.onPressIn}
        onPressOut={press.onPressOut}
      >
        {({ pressed }) => (
          <BevelView fill={wash(tone, pressed ? 0.26 : 0.13)} cut={bevels.card} style={styles.card}>
            <SportIcon sport={sport} variant="badge" />
            <View style={styles.text}>
              <Text variant="bodyStrong">Enregistrer une sortie</Text>
              <Text variant="small" tone="secondary" numberOfLines={1}>
                {`${sports[sport].label} · GPS en direct`}
              </Text>
            </View>
            <View style={[styles.go, { backgroundColor: colors.actBg }]}>
              <Icon name="play" size={18} color={colors.actInk} />
            </View>
          </BevelView>
        )}
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  frame: { marginBottom: 12 },
  card: { flexDirection: "row", alignItems: "center", gap: 12, minHeight: 72, paddingHorizontal: 14, paddingVertical: 12 },
  text: { flex: 1, minWidth: 0, gap: 2 },
  go: { width: 44, height: 44, borderRadius: 22, alignItems: "center", justifyContent: "center" },
  web: { flexDirection: "row", alignItems: "center", gap: 10, minHeight: 52, paddingHorizontal: 14, marginBottom: 12, borderWidth: 1, borderRadius: 12 },
  webText: { flex: 1 },
});
