import { Pressable, StyleSheet, View } from "react-native";
import type { StyleProp, ViewStyle } from "react-native";
import Animated from "react-native-reanimated";
import { impactAsync, ImpactFeedbackStyle } from "expo-haptics";
import type { RecorderPhase } from "@obnixe/core";
import { HoldButton } from "@/features/recording/LiveParts";
import { Icon } from "@/ui/icons/Icon";
import type { IconName } from "@/ui/icons/Icon";
import { usePressScale } from "@/ui/motion";
import { BevelView } from "@/ui/Shapes";
import { Text } from "@/ui/Text";
import { useTheme } from "@/ui/theme";
import { bevels, fonts, radii } from "@/ui/tokens";

const controlHeight = 72;

interface BigButtonProps {
  readonly label: string;
  readonly accessibilityLabel: string;
  readonly icon: IconName;
  readonly tone: "act" | "plain";
  readonly onPress: () => void;
  readonly disabled: boolean;
  readonly style?: StyleProp<ViewStyle>;
}

function BigButton({ label, accessibilityLabel, icon, tone, onPress, disabled, style }: BigButtonProps) {
  const { colors } = useTheme();
  const press = usePressScale(0.96);
  const ink = tone === "act" ? colors.actInk : colors.text;
  return (
    <Animated.View style={[press.style, disabled && styles.disabled, style]}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
        aria-disabled={disabled}
        disabled={disabled}
        onPress={() => {
          void impactAsync(ImpactFeedbackStyle.Medium);
          onPress();
        }}
        onPressIn={press.onPressIn}
        onPressOut={press.onPressOut}
      >
        {({ pressed }) =>
          tone === "act" ? (
            <BevelView fill={pressed ? colors.actPress : colors.actBg} cut={bevels.button} corner="bottomRight" style={styles.big}>
              <Icon name={icon} size={22} color={ink} />
              <Text style={[styles.bigLabel, { color: ink }]}>{label}</Text>
            </BevelView>
          ) : (
            <View style={[styles.big, styles.plain, { backgroundColor: pressed ? colors.surfacePress : colors.surface2 }]}>
              <Icon name={icon} size={20} color={ink} />
              <Text style={[styles.bigLabel, { color: ink }]}>{label}</Text>
            </View>
          )
        }
      </Pressable>
    </Animated.View>
  );
}

interface LiveControlsProps {
  readonly phase: RecorderPhase;
  readonly locked: boolean;
  readonly busy: boolean;
  readonly onLap: () => void;
  readonly onPause: () => void;
  readonly onResume: () => void;
  readonly onStop: () => void;
  readonly onConfirmStop: () => void;
  readonly onUnlock: () => void;
}

/** `UX-003`: large targets, *Terminer* and the unlock after a long press. */
export function LiveControls({ phase, locked, busy, onLap, onPause, onResume, onStop, onConfirmStop, onUnlock }: LiveControlsProps) {
  if (locked) {
    return (
      <View style={styles.row}>
        <HoldButton
          label="Déverrouiller"
          hint="Maintenir appuyé"
          icon="unlock"
          tone="neutral"
          onHeld={onUnlock}
          onAccessibilityActivate={onUnlock}
          style={styles.fill}
        />
      </View>
    );
  }
  const paused = phase === "paused";
  const stop = (
    <HoldButton
      label="Terminer"
      hint="Maintenir appuyé"
      icon="stop"
      tone="stop"
      disabled={busy || phase === "preparing"}
      onHeld={onStop}
      onAccessibilityActivate={onConfirmStop}
      style={styles.side}
    />
  );
  if (paused) {
    return (
      <View style={styles.row}>
        <BigButton label="Reprendre" accessibilityLabel="Reprendre l'enregistrement" icon="play" tone="act" disabled={busy} onPress={onResume} style={styles.main} />
        {stop}
      </View>
    );
  }
  return (
    <View style={styles.row}>
      <BigButton label="Tour" accessibilityLabel="Marquer un tour" icon="flag" tone="plain" disabled={busy || phase === "preparing"} onPress={onLap} style={styles.side} />
      <BigButton label="Pause" accessibilityLabel="Mettre en pause" icon="pause" tone="act" disabled={busy || phase === "preparing"} onPress={onPause} style={styles.main} />
      {stop}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", gap: 10 },
  fill: { flex: 1, height: controlHeight },
  main: { flex: 1.35 },
  side: { flex: 1, height: controlHeight },
  big: { height: controlHeight, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, paddingHorizontal: 10 },
  plain: { borderRadius: radii.panel },
  bigLabel: { fontFamily: fonts.brand700, fontSize: 18 },
  disabled: { opacity: 0.4 },
});
