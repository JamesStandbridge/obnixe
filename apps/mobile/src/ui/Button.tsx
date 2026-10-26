import { Animated, Pressable, StyleSheet } from "react-native";
import type { ReactNode } from "react";
import type { StyleProp, ViewStyle } from "react-native";
import { usePressScale } from "@/ui/motion";
import { Text } from "@/ui/Text";
import { useTheme } from "@/ui/theme";
import { fonts, layout, radii } from "@/ui/tokens";

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

export function PrimaryButton({ label, onPress, disabled = false, icon, style, compact = false }: PrimaryButtonProps) {
  const { colors } = useTheme();
  const press = usePressScale(0.98);
  return (
    <Animated.View style={[{ transform: [{ scale: press.scale }] }, style]}>
      <Pressable
        accessibilityRole="button"
        aria-disabled={disabled}
        disabled={disabled}
        onPress={onPress}
        onPressIn={press.onPressIn}
        onPressOut={press.onPressOut}
        style={({ pressed }) => [
          styles.primary,
          compact && styles.primaryCompact,
          disabled
            ? { backgroundColor: colors.surface, borderColor: colors.controlBorder, borderWidth: layout.borderControl }
            : { backgroundColor: pressed ? colors.actPress : colors.actBg },
        ]}
      >
        {icon}
        <Text variant="bodyStrong" tone={disabled ? "primary" : "act"} style={[styles.primaryLabel, compact && styles.primaryCompactLabel]}>
          {label}
        </Text>
      </Pressable>
    </Animated.View>
  );
}

export function SheetButton({ label, onPress, disabled = false, style }: ButtonProps) {
  const { colors } = useTheme();
  const press = usePressScale(0.98);
  return (
    <Animated.View style={[{ transform: [{ scale: press.scale }] }, disabled && styles.disabled, style]}>
      <Pressable
        accessibilityRole="button"
        aria-disabled={disabled}
        disabled={disabled}
        onPress={onPress}
        onPressIn={press.onPressIn}
        onPressOut={press.onPressOut}
        style={[styles.sheet, { backgroundColor: colors.text }]}
      >
        <Text variant="bodyStrong" tone="inverse" style={styles.sheetLabel}>
          {label}
        </Text>
      </Pressable>
    </Animated.View>
  );
}

export function ControlButton({ label, onPress, disabled = false, icon, style }: ButtonProps) {
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      aria-disabled={disabled}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.control,
        { backgroundColor: pressed ? colors.surfacePress : colors.surface, borderColor: colors.controlBorder },
        disabled && styles.disabled,
        style,
      ]}
    >
      {icon}
      <Text variant="label">{label}</Text>
    </Pressable>
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
      <Text variant="label" style={styles.linkLabel}>
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  primary: {
    minHeight: 64,
    paddingHorizontal: 16,
    borderRadius: radii.panel,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
  },
  primaryLabel: { fontFamily: fonts.text700, fontSize: 18 },
  primaryCompact: { minHeight: 56 },
  primaryCompactLabel: { fontSize: 17 },
  sheet: { minHeight: 56, paddingHorizontal: 16, borderRadius: radii.panel, alignItems: "center", justifyContent: "center" },
  sheetLabel: { fontFamily: fonts.text700, fontSize: 17 },
  control: {
    minHeight: 48,
    paddingHorizontal: 14,
    borderRadius: radii.control,
    borderWidth: layout.borderControl,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
  },
  link: { minHeight: layout.hitSlop, paddingHorizontal: 10, borderRadius: radii.control, justifyContent: "center" },
  linkLabel: { fontFamily: fonts.text700, textDecorationLine: "underline" },
  disabled: { opacity: 0.4 },
});
