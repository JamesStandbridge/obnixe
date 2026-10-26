import { useEffect, useRef } from "react";
import { Animated, Pressable, StyleSheet, View } from "react-native";
import type { ViewStyle } from "react-native";
import type { PainLevel } from "@obnixe/schema";
import { Icon } from "@/ui/icons/Icon";
import type { IconName } from "@/ui/icons/Icon";
import { easeOut, usePressScale } from "@/ui/motion";
import { Text } from "@/ui/Text";
import { useTheme } from "@/ui/theme";
import { durations, fonts, layout, radii } from "@/ui/tokens";

export interface SegmentOption<T extends string> {
  readonly value: T;
  readonly label: string;
}

interface SegmentedProps<T extends string> {
  readonly options: readonly SegmentOption<T>[];
  readonly value: T | null;
  readonly onChange: (value: T) => void;
}

export function Segmented<T extends string>({ options, value, onChange }: SegmentedProps<T>) {
  const { colors } = useTheme();
  return (
    <View style={styles.segmented} accessibilityRole="radiogroup">
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <Pressable
            key={option.value}
            accessibilityRole="radio"
            aria-checked={selected}
            onPress={() => onChange(option.value)}
            style={({ pressed }) => [
              styles.segment,
              {
                borderColor: selected ? colors.text : colors.controlBorder,
                borderWidth: selected ? 2 : layout.borderControl,
                backgroundColor: selected || pressed ? colors.surface : "transparent",
              },
            ]}
          >
            <Text
              variant="label"
              tone={selected ? "primary" : "secondary"}
              style={selected ? styles.segmentSelected : undefined}
            >
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

interface SwitchProps {
  readonly value: boolean;
  readonly onChange: (value: boolean) => void;
  readonly label: string;
}

export function Switch({ value, onChange, label }: SwitchProps) {
  const { colors, reduceMotion } = useTheme();
  const progress = useRef(new Animated.Value(value ? 1 : 0)).current;

  useEffect(() => {
    Animated.timing(progress, {
      toValue: value ? 1 : 0,
      duration: reduceMotion ? 0 : durations.state,
      easing: easeOut,
      useNativeDriver: false,
    }).start();
  }, [value, reduceMotion, progress]);

  return (
    <Pressable
      accessibilityRole="switch"
      accessibilityLabel={label}
      aria-checked={value}
      hitSlop={6}
      onPress={() => onChange(!value)}
    >
      <Animated.View
        style={[
          styles.track,
          {
            backgroundColor: progress.interpolate({ inputRange: [0, 1], outputRange: ["transparent", colors.text] }),
            borderColor: progress.interpolate({ inputRange: [0, 1], outputRange: [colors.controlBorder, colors.text] }),
          },
        ]}
      >
        <Animated.View
          style={[
            styles.thumb,
            {
              backgroundColor: progress.interpolate({ inputRange: [0, 1], outputRange: [colors.text2, colors.bg] }),
              transform: [{ translateX: progress.interpolate({ inputRange: [0, 1], outputRange: [0, 20] }) }],
            },
          ]}
        />
      </Animated.View>
    </Pressable>
  );
}

export type StepButtonSize = "compact" | "regular" | "tall";

type StepButtonFace = { readonly label: string; readonly icon?: never } | { readonly icon: IconName; readonly label?: never };

type StepButtonProps = StepButtonFace & {
  readonly accessibilityLabel: string;
  readonly disabled?: boolean;
  readonly size?: StepButtonSize;
  readonly onPress: () => void;
};

const stepSizes: Readonly<Record<StepButtonSize, ViewStyle>> = {
  compact: { width: 52, height: 52 },
  regular: { width: 56, minHeight: 56 },
  tall: { width: 64, height: 72 },
};

export function StepButton({ accessibilityLabel, disabled = false, size = "regular", onPress, ...face }: StepButtonProps) {
  const { colors } = useTheme();
  const press = usePressScale(0.96);
  return (
    <Animated.View style={[{ transform: [{ scale: press.scale }] }, disabled && styles.disabled]}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
        accessibilityState={{ disabled }}
        disabled={disabled}
        onPress={onPress}
        onPressIn={press.onPressIn}
        onPressOut={press.onPressOut}
        style={({ pressed }) => [
          styles.step,
          stepSizes[size],
          { backgroundColor: pressed ? colors.surfacePress : colors.surface, borderColor: colors.controlBorder },
        ]}
      >
        {face.icon === undefined ? <Text style={styles.stepLabel}>{face.label}</Text> : <Icon name={face.icon} />}
      </Pressable>
    </Animated.View>
  );
}

interface StepperProps {
  readonly value: number;
  readonly step: number;
  readonly min: number;
  readonly max: number;
  readonly unit: string;
  readonly label: string;
  readonly format: (value: number) => string;
  readonly onChange: (value: number) => void;
  readonly onPressValue?: () => void;
}

export function Stepper({ value, step, min, max, unit, label, format, onChange, onPressValue }: StepperProps) {
  const { colors } = useTheme();
  const display = format(value);
  return (
    <View style={styles.stepper}>
      <StepButton
        label="−"
        accessibilityLabel={`${label} moins ${format(step)}`}
        disabled={value - step < min}
        onPress={() => onChange(value - step)}
      />
      <Pressable
        accessibilityRole={onPressValue === undefined ? "text" : "button"}
        accessibilityLabel={`${label} ${display} ${unit}`}
        disabled={onPressValue === undefined}
        onPress={onPressValue}
        style={({ pressed }) => [styles.stepValue, pressed && { backgroundColor: colors.surface }]}
      >
        <Text variant="figure">{display}</Text>
        <Text variant="small" tone="secondary" style={styles.stepUnit}>
          {unit}
        </Text>
      </Pressable>
      <StepButton
        label="+"
        accessibilityLabel={`${label} plus ${format(step)}`}
        disabled={value + step > max}
        onPress={() => onChange(value + step)}
      />
    </View>
  );
}

interface PainMarkProps {
  readonly level: Exclude<PainLevel, "none">;
}

export function PainMark({ level }: PainMarkProps) {
  const { colors } = useTheme();
  switch (level) {
    case "discomfort":
      return <View style={[styles.painMark, styles.painDiscomfort, { borderColor: colors.warn }]} />;
    case "stop":
      return <View style={[styles.painMark, styles.painStop, { backgroundColor: colors.stop }]} />;
    default: {
      const unreachable: never = level;
      return unreachable;
    }
  }
}

interface TagProps {
  readonly label: string;
}

export function Tag({ label }: TagProps) {
  const { colors } = useTheme();
  return (
    <View style={[styles.tag, { borderColor: colors.controlBorder }]}>
      <Text variant="eyebrow" maxFontSizeMultiplier={1.3} style={styles.tagLabel}>
        {label}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  segmented: { flexDirection: "row", gap: 6 },
  segment: {
    flex: 1,
    minHeight: 48,
    paddingVertical: 6,
    paddingHorizontal: 8,
    borderRadius: radii.control,
    alignItems: "center",
    justifyContent: "center",
  },
  segmentSelected: { fontFamily: fonts.text700 },
  track: { width: 52, height: 32, borderRadius: 16, borderWidth: layout.borderControl, padding: 4.5 },
  thumb: { width: 20, height: 20, borderRadius: 10 },
  stepper: { flexDirection: "row", alignItems: "center", gap: 6 },
  step: {
    borderRadius: radii.control,
    borderWidth: layout.borderControl,
    alignItems: "center",
    justifyContent: "center",
  },
  stepLabel: { fontFamily: fonts.figure700, fontSize: 22, lineHeight: 24 },
  stepValue: {
    flex: 1,
    minHeight: 56,
    borderRadius: radii.control,
    flexDirection: "row",
    alignItems: "baseline",
    justifyContent: "center",
    gap: 6,
  },
  stepUnit: { fontFamily: fonts.text600 },
  painMark: { width: 8, height: 8 },
  painDiscomfort: { borderRadius: 4, borderWidth: 2 },
  painStop: { borderRadius: 1 },
  tag: {
    minHeight: 20,
    paddingHorizontal: 6,
    borderRadius: radii.tag,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  tagLabel: { letterSpacing: 0.24, textTransform: "none" },
  disabled: { opacity: 0.4 },
});
