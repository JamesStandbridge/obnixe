import { Pressable, StyleSheet, View } from "react-native";
import type { ReactNode } from "react";
import type { StyleProp, ViewStyle } from "react-native";
import Animated from "react-native-reanimated";
import Svg, { Polygon } from "react-native-svg";
import { impactAsync, ImpactFeedbackStyle } from "expo-haptics";
import { usePressScale } from "@/ui/motion";
import { BevelView } from "@/ui/Shapes";
import { Text } from "@/ui/Text";
import { useTheme } from "@/ui/theme";
import { bevels, fonts, layout, radii } from "@/ui/tokens";

interface ButtonProps {
  readonly label: string;
  readonly onPress: () => void;
  readonly disabled?: boolean;
  readonly icon?: ReactNode;
  readonly style?: StyleProp<ViewStyle>;
}

interface PrimaryButtonProps extends ButtonProps {
  readonly compact?: boolean;
}

function Stripes({ color }: { readonly color: string }) {
  return (
    <View pointerEvents="none" style={styles.stripes}>
      <Svg width={34} height={22}>
        <Polygon points="10,0 18,0 8,22 0,22" fill={color} />
        <Polygon points="24,0 32,0 22,22 14,22" fill={color} />
      </Svg>
    </View>
  );
}

export function PrimaryButton({ label, onPress, disabled = false, icon, style, compact = false }: PrimaryButtonProps) {
  const { colors } = useTheme();
  const press = usePressScale(0.97);
  const activate = (): void => {
    void impactAsync(ImpactFeedbackStyle.Light);
    onPress();
  };
  return (
    <Animated.View style={[press.style, style]}>
      <Pressable accessibilityRole="button" aria-disabled={disabled} disabled={disabled} onPress={activate} onPressIn={press.onPressIn} onPressOut={press.onPressOut}>
        {({ pressed }) => (
          <BevelView
            fill={disabled ? colors.surface : pressed ? colors.actPress : colors.actBg}
            {...(disabled ? { stroke: colors.controlBorder } : {})}
            cut={bevels.button}
            corner="bottomRight"
            style={[styles.primary, compact && styles.primaryCompact]}
          >
            {disabled ? null : <Stripes color={colors.actPress} />}
            {icon}
            <Text variant="bodyStrong" tone={disabled ? "secondary" : "act"} style={[styles.primaryLabel, compact && styles.primaryCompactLabel]}>
              {label}
            </Text>
          </BevelView>
        )}
      </Pressable>
    </Animated.View>
  );
}

export function SheetButton({ label, onPress, disabled = false, style }: ButtonProps) {
  const { colors } = useTheme();
  const press = usePressScale(0.97);
  return (
    <Animated.View style={[press.style, disabled && styles.disabled, style]}>
      <Pressable accessibilityRole="button" aria-disabled={disabled} disabled={disabled} onPress={onPress} onPressIn={press.onPressIn} onPressOut={press.onPressOut}>
        <BevelView fill={colors.text} cut={bevels.button} corner="bottomRight" style={styles.sheet}>
          <Text variant="bodyStrong" tone="inverse" style={styles.sheetLabel}>
            {label}
          </Text>
        </BevelView>
      </Pressable>
    </Animated.View>
  );
}

export function ControlButton({ label, onPress, disabled = false, icon, style }: ButtonProps) {
  const { colors } = useTheme();
  const press = usePressScale(0.97);
  return (
    <Animated.View style={[press.style, disabled && styles.disabled, style]}>
      <Pressable
        accessibilityRole="button"
        aria-disabled={disabled}
        disabled={disabled}
        onPress={onPress}
        onPressIn={press.onPressIn}
        onPressOut={press.onPressOut}
        style={({ pressed }) => [styles.control, { backgroundColor: pressed ? colors.surfacePress : colors.surface2 }]}
      >
        {icon}
        <Text variant="label">{label}</Text>
      </Pressable>
    </Animated.View>
  );
}

export function LinkButton({ label, onPress, disabled = false, style }: ButtonProps) {
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      aria-disabled={disabled}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [styles.link, pressed && { backgroundColor: colors.surface }, disabled && styles.disabled, style]}
    >
      <Text variant="label" style={[styles.linkLabel, { color: colors.mark }]}>
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  primary: {
    minHeight: 64,
    paddingHorizontal: 20,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    overflow: "hidden",
  },
  primaryLabel: { fontFamily: fonts.brand700, fontSize: 18, letterSpacing: -0.1 },
  primaryCompact: { minHeight: 56 },
  primaryCompactLabel: { fontSize: 17 },
  stripes: { position: "absolute", right: 22, top: 0, bottom: 0, justifyContent: "center" },
  sheet: { minHeight: 56, paddingHorizontal: 16, alignItems: "center", justifyContent: "center" },
  sheetLabel: { fontFamily: fonts.brand700, fontSize: 17 },
  control: {
    minHeight: 48,
    paddingHorizontal: 14,
    borderRadius: radii.control,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
  },
  link: { minHeight: layout.hitSlop, paddingHorizontal: 10, borderRadius: radii.control, justifyContent: "center" },
  linkLabel: { fontFamily: fonts.text700 },
  disabled: { opacity: 0.4 },
});
