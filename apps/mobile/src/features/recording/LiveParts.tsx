import { memo, useEffect, useRef } from "react";
import type { ReactNode } from "react";
import { PixelRatio, Pressable, StyleSheet, TextInput, View } from "react-native";
import type { StyleProp, TextInputProps, TextStyle, ViewStyle } from "react-native";
import Animated, { cancelAnimation, Easing, useAnimatedProps, useAnimatedStyle, useFrameCallback, useSharedValue, withTiming } from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { impactAsync, ImpactFeedbackStyle, notificationAsync, NotificationFeedbackType } from "expo-haptics";
import type { SignalLevel } from "@obnixe/core";
import type { EpochMs } from "@obnixe/schema";
import { fitBounds, metricSizes } from "@/features/recording/metricSizes";
import type { MetricSizeKey } from "@/features/recording/metricSizes";
import type { MetricText } from "@/features/recording/metrics";
import { Icon } from "@/ui/icons/Icon";
import type { IconName } from "@/ui/icons/Icon";
import { Text } from "@/ui/Text";
import { useTheme } from "@/ui/theme";
import { fonts, radii } from "@/ui/tokens";

const AnimatedInput = Animated.createAnimatedComponent(TextInput);

/** Long press of `UX-003`, for *Terminer* and the unlock. */
export const holdMs = 800;

function clockText(totalSeconds: number): string {
  "worklet";
  const whole = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const seconds = whole % 60;
  const tail = `${seconds < 10 ? "0" : ""}${seconds}`;
  if (hours === 0) return `${minutes}:${tail}`;
  return `${hours}:${minutes < 10 ? "0" : ""}${minutes}:${tail}`;
}

interface ChronometerProps {
  /** Running from this instant, or frozen at `frozenMs` when null. */
  readonly baseAt: EpochMs | null;
  readonly frozenMs: number;
  readonly style?: StyleProp<TextStyle>;
}

/** `PRF-041`: the seconds tick on the UI thread from a shared value, without a React render each second. */
export const Chronometer = memo(function Chronometer({ baseAt, frozenMs, style }: ChronometerProps) {
  const { colors } = useTheme();
  const base = useSharedValue(baseAt ?? 0);
  const seconds = useSharedValue(Math.floor((baseAt === null ? frozenMs : Date.now() - baseAt) / 1000));
  const running = baseAt !== null;
  const frame = useFrameCallback(() => {
    "worklet";
    const next = Math.floor((Date.now() - base.value) / 1000);
    if (next !== seconds.value) seconds.value = next;
  }, running);

  useEffect(() => {
    if (baseAt !== null) base.value = baseAt;
    else seconds.value = Math.floor(frozenMs / 1000);
    frame.setActive(baseAt !== null);
  }, [baseAt, frozenMs, base, seconds, frame]);

  const animatedProps = useAnimatedProps(() => ({ text: clockText(seconds.value) }) as Partial<TextInputProps>);
  return (
    <AnimatedInput
      editable={false}
      accessible={false}
      importantForAccessibility="no"
      underlineColorAndroid="transparent"
      defaultValue={clockText(seconds.value)}
      animatedProps={animatedProps}
      style={[styles.chronometer, { color: colors.text }, style]}
    />
  );
});

const signalWords: Readonly<Record<SignalLevel, string>> = { none: "aucun", weak: "faible", fair: "correct", good: "bon" };
const signalBars: Readonly<Record<SignalLevel, number>> = { none: 0, weak: 1, fair: 2, good: 3 };

export function signalWord(level: SignalLevel): string {
  return signalWords[level];
}

interface SignalBarsProps {
  readonly level: SignalLevel;
  readonly size?: number;
}

export function SignalBars({ level, size = 18 }: SignalBarsProps) {
  const { colors } = useTheme();
  const lit = signalBars[level];
  const tone = level === "weak" ? colors.warn : level === "none" ? colors.text3 : colors.text;
  return (
    <View style={[styles.bars, { height: size }]} accessible accessibilityLabel={`Signal GPS ${signalWords[level]}`}>
      {[0, 1, 2].map((index) => (
        <View key={index} style={[styles.bar, { height: size * (0.45 + index * 0.275), backgroundColor: index < lit ? tone : colors.line }]} />
      ))}
    </View>
  );
}

interface MetricTileProps {
  readonly caption: string;
  readonly text: MetricText;
  readonly scale: MetricSizeKey;
  readonly accent?: string;
  readonly style?: StyleProp<ViewStyle>;
}

export function MetricTile({ caption, text, scale, accent, style }: MetricTileProps) {
  const { colors } = useTheme();
  const metric = metricSizes[scale];
  const { size } = metric;
  const { minimumFontScale, minimumFontSize } = fitBounds(metric, PixelRatio.get());
  return (
    <View style={[styles.tile, style]} accessible accessibilityLabel={`${caption}, ${text.value}${text.unit === "" ? "" : ` ${text.unit}`}`}>
      <View style={styles.tileHead}>
        {accent === undefined ? null : <View style={[styles.tileAccent, { backgroundColor: accent }]} />}
        <Text style={[styles.caption, { color: colors.text2 }]} numberOfLines={1} maxFontSizeMultiplier={1.2}>
          {caption}
        </Text>
      </View>
      <View style={styles.valueRow}>
        <Text
          numberOfLines={1}
          adjustsFontSizeToFit
          minimumFontScale={minimumFontScale}
          {...{ minimumFontSize }}
          maxFontSizeMultiplier={1}
          style={[styles.value, { fontSize: size, lineHeight: Math.round(size * 1.02), color: colors.text, letterSpacing: size > 60 ? -2 : -0.8 }]}
        >
          {text.value}
        </Text>
        {text.unit === "" ? null : (
          <Text maxFontSizeMultiplier={1.2} style={[styles.unit, { fontSize: Math.max(15, Math.round(size * 0.28)), color: colors.text2 }]}>
            {text.unit}
          </Text>
        )}
      </View>
    </View>
  );
}

interface HoldButtonProps {
  readonly label: string;
  readonly hint: string;
  readonly icon: IconName;
  readonly tone: "stop" | "neutral";
  readonly onHeld: () => void;
  /** Screen readers activate at once: the caller confirms instead (`UX-003`). */
  readonly onAccessibilityActivate: () => void;
  readonly disabled?: boolean;
  readonly style?: StyleProp<ViewStyle>;
  readonly children?: ReactNode;
}

/**
 * `UX-003`: a long press of 800 ms, the fill showing the progress, then a vibration; it acts on release, since unmounting
 * the pressed view swallows the next touch on Android. Released early, it drains back.
 */
export function HoldButton({ label, hint, icon, tone, onHeld, onAccessibilityActivate, disabled = false, style }: HoldButtonProps) {
  const { colors, reduceMotion } = useTheme();
  const progress = useSharedValue(0);
  const held = useRef(false);
  const ink = tone === "stop" ? colors.stop : colors.text;

  const complete = (): void => {
    held.current = true;
    void notificationAsync(NotificationFeedbackType.Warning);
  };

  const start = (): void => {
    held.current = false;
    void impactAsync(ImpactFeedbackStyle.Light);
    progress.value = withTiming(1, { duration: holdMs, easing: Easing.linear }, (finished) => {
      "worklet";
      if (finished === true) scheduleOnRN(complete);
    });
  };

  const release = (): void => {
    if (held.current) {
      onHeld();
      return;
    }
    cancelAnimation(progress);
    progress.value = withTiming(0, { duration: reduceMotion ? 0 : 180 });
  };

  useEffect(() => () => cancelAnimation(progress), [progress]);

  const fill = useAnimatedStyle(() => ({ transform: [{ scaleX: progress.value }] }));

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={hint}
      accessibilityActions={[{ name: "activate" }]}
      onAccessibilityAction={(event) => {
        if (event.nativeEvent.actionName === "activate") onAccessibilityActivate();
      }}
      aria-disabled={disabled}
      disabled={disabled}
      onPressIn={start}
      onPressOut={release}
      style={[styles.hold, { borderColor: ink, backgroundColor: colors.surface }, disabled && styles.disabled, style]}
    >
      <Animated.View pointerEvents="none" style={[styles.holdFill, { backgroundColor: tone === "stop" ? colors.stop : colors.surfacePress }, fill]} />
      <Icon name={icon} size={18} color={ink} />
      <View style={styles.holdText}>
        <Text style={[styles.holdLabel, { color: ink }]} numberOfLines={1}>
          {label}
        </Text>
        <Text variant="caption" tone="secondary" numberOfLines={1} maxFontSizeMultiplier={1.2}>
          {hint}
        </Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  chronometer: { fontFamily: fonts.figure800, fontSize: 26, lineHeight: 30, padding: 0, margin: 0, fontVariant: ["tabular-nums"], includeFontPadding: false },
  bars: { flexDirection: "row", alignItems: "flex-end", gap: 2.5 },
  bar: { width: 4, borderRadius: 1.5 },
  tile: { minWidth: 0, gap: 2 },
  tileHead: { flexDirection: "row", alignItems: "center", gap: 6 },
  tileAccent: { width: 4, height: 12, borderRadius: 2 },
  caption: { fontFamily: fonts.text700, fontSize: 13, lineHeight: 16, letterSpacing: 0.9, textTransform: "uppercase" },
  valueRow: { flexDirection: "row", alignItems: "baseline", gap: 5 },
  value: { flexShrink: 1, fontFamily: fonts.figure800 },
  unit: { fontFamily: fonts.figure700 },
  hold: { height: 64, borderRadius: radii.panel, borderWidth: 2, overflow: "hidden", flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, paddingHorizontal: 10 },
  holdFill: { position: "absolute", left: 0, top: 0, bottom: 0, right: 0, opacity: 0.28, transformOrigin: "left" },
  holdText: { flexShrink: 1, alignItems: "flex-start" },
  holdLabel: { fontFamily: fonts.brand700, fontSize: 17, lineHeight: 20 },
  disabled: { opacity: 0.4 },
});
