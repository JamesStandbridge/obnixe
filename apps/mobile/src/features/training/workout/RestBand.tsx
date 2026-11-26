import { useEffect } from "react";
import { StyleSheet, View } from "react-native";
import Animated, { Easing, useAnimatedStyle, useSharedValue, withSequence, withSpring, withTiming } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { formatClock } from "@/format/durations";
import { springs } from "@/ui/motion";
import { Slash } from "@/ui/Shapes";
import { Text } from "@/ui/Text";
import { useTheme } from "@/ui/theme";
import { fonts, layout } from "@/ui/tokens";

export type Band =
  | { readonly kind: "idle" }
  | { readonly kind: "running"; readonly remaining: number; readonly total: number }
  | { readonly kind: "done"; readonly over: number }
  | { readonly kind: "active"; readonly label: string; readonly elapsed: number };

interface RestBandProps {
  readonly band: Band;
}

export const restBandHeight = 64;

export function RestBand({ band }: RestBandProps) {
  const { colors, reduceMotion } = useTheme();
  const insets = useSafeAreaInsets();
  const offset = useSharedValue(0);
  const share = useSharedValue(1);
  const ratio = band.kind === "running" && band.total > 0 ? Math.max(0, band.remaining) / band.total : 0;

  useEffect(() => {
    if (band.kind !== "done" || reduceMotion) return;
    offset.value = withSequence(withTiming(-8, { duration: 90 }), withSpring(0, springs.bounce));
  }, [band.kind, reduceMotion, offset]);

  useEffect(() => {
    share.value = reduceMotion ? ratio : withTiming(ratio, { duration: 950, easing: Easing.linear });
  }, [ratio, reduceMotion, share]);

  const lineStyle = useAnimatedStyle(() => ({ transform: [{ translateY: offset.value }] }));
  const fillStyle = useAnimatedStyle(() => ({ width: `${share.value * 100}%` }));

  const done = band.kind === "done";
  const ink = done ? colors.actInk : colors.text;
  return (
    <View
      accessibilityRole="timer"
      accessibilityLiveRegion="polite"
      style={[
        styles.band,
        { height: insets.top + restBandHeight, paddingTop: insets.top, backgroundColor: done ? colors.actBg : colors.bg, borderBottomColor: done ? "transparent" : colors.line },
      ]}
    >
      <Animated.View style={[styles.line, done && styles.lineCentered, lineStyle]}>
        {(() => {
          switch (band.kind) {
            case "idle":
              return (
                <Text variant="bodyStrong" tone="secondary">
                  Aucun repos en cours
                </Text>
              );
            case "running":
              return (
                <>
                  <Text variant="eyebrow" tone="secondary">
                    Repos
                  </Text>
                  <Text style={[styles.figure, { color: ink }]}>{formatClock(band.remaining)}</Text>
                  <Text style={[styles.total, { color: colors.text3 }]}>/ {formatClock(band.total)}</Text>
                </>
              );
            case "done":
              return (
                <>
                  <Slash color={ink} width={12} height={18} />
                  <Text style={[styles.doneLabel, { color: ink }]}>Repos terminé depuis</Text>
                  <Text style={[styles.figure, styles.push, { color: ink }]}>{formatClock(band.over)}</Text>
                </>
              );
            case "active":
              return (
                <>
                  <Text variant="eyebrow" tone="secondary">
                    {band.label}
                  </Text>
                  <Text style={[styles.figure, styles.push, { color: ink }]}>{formatClock(band.elapsed)}</Text>
                </>
              );
            default: {
              const unreachable: never = band;
              return unreachable;
            }
          }
        })()}
      </Animated.View>
      {band.kind === "running" ? (
        <View style={[styles.track, { backgroundColor: colors.surface2 }]}>
          <Animated.View style={[styles.fill, { backgroundColor: colors.brand }, fillStyle]} />
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  band: { paddingHorizontal: layout.gutter, justifyContent: "center", gap: 10, borderBottomWidth: 1 },
  line: { flexDirection: "row", alignItems: "baseline", gap: 10 },
  lineCentered: { alignItems: "center" },
  figure: { fontFamily: fonts.figure800, fontSize: 32, lineHeight: 34, letterSpacing: -0.3 },
  total: { fontFamily: fonts.figure600, fontSize: 18, lineHeight: 20 },
  doneLabel: { fontFamily: fonts.brand700, fontSize: 18, lineHeight: 20 },
  push: { marginLeft: "auto" },
  track: { height: 4, borderRadius: 2, overflow: "hidden", transform: [{ skewX: "-20deg" }] },
  fill: { height: "100%" },
});
