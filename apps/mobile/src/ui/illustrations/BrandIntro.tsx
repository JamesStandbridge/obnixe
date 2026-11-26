import { useEffect, useState } from "react";
import { StyleSheet, useWindowDimensions, View } from "react-native";
import Animated, { Easing, interpolate, useAnimatedStyle, useSharedValue, withDelay, withTiming } from "react-native-reanimated";
import type { SharedValue } from "react-native-reanimated";
import Svg from "react-native-svg";
import { scheduleOnRN } from "react-native-worklets";
import type { SportKey } from "@obnixe/schema";
import { Shard } from "@/ui/illustrations/motion";
import type { ShardShape } from "@/ui/illustrations/motion";
import { LogoMark } from "@/ui/illustrations/scenes";
import { useTheme } from "@/ui/theme";

// Must match the expo-splash-screen plugin in app.json so the hand-off is seamless.
const splash = { background: "#e5ed32", ink: "#0c1013", accent: "#6f7414", imageWidth: 120 } as const;

interface Burst {
  readonly angle: number;
  readonly distance: number;
  readonly size: number;
  readonly shape: ShardShape;
  readonly color: (sport: Readonly<Record<SportKey, string>>) => string;
}

const bursts: readonly Burst[] = [
  { angle: -2.4, distance: 150, size: 22, shape: "slab", color: (sport) => sport.strength },
  { angle: -0.6, distance: 170, size: 18, shape: "triangle", color: (sport) => sport.run },
  { angle: 0.5, distance: 140, size: 16, shape: "diamond", color: (sport) => sport.climb },
  { angle: 2.2, distance: 160, size: 20, shape: "slab", color: (sport) => sport.swim },
  { angle: 1.4, distance: 190, size: 14, shape: "triangle", color: (sport) => sport.yoga },
];

function BurstShard({ burst, progress, color }: { readonly burst: Burst; readonly progress: SharedValue<number>; readonly color: string }) {
  const style = useAnimatedStyle(() => {
    const travel = interpolate(progress.value, [0, 1], [0, burst.distance]);
    return {
      opacity: interpolate(progress.value, [0, 0.1, 0.8, 1], [0, 1, 1, 0]),
      transform: [{ translateX: Math.cos(burst.angle) * travel }, { translateY: Math.sin(burst.angle) * travel }, { rotate: `${progress.value * 220}deg` }],
    };
  });
  return (
    <Animated.View style={[styles.shard, style]}>
      <Shard shape={burst.shape} color={color} size={burst.size} />
    </Animated.View>
  );
}

/** Continues the native splash: the mark grows, shards burst out and the yellow panel slides away. */
export function BrandIntro() {
  const { colors, reduceMotion } = useTheme();
  const { width } = useWindowDimensions();
  const [done, setDone] = useState(reduceMotion);
  const progress = useSharedValue(0);

  useEffect(() => {
    if (reduceMotion) return;
    progress.value = withDelay(
      160,
      withTiming(1, { duration: 720, easing: Easing.inOut(Easing.cubic) }, (finished) => {
        if (finished === true) scheduleOnRN(setDone, true);
      }),
    );
  }, [reduceMotion, progress]);

  const panelStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: interpolate(progress.value, [0.25, 1], [0, -width * 1.9], "clamp") }, { skewX: "-14deg" }],
  }));
  const markStyle = useAnimatedStyle(() => ({
    opacity: interpolate(progress.value, [0.35, 0.75], [1, 0], "clamp"),
    transform: [{ scale: interpolate(progress.value, [0, 0.4, 1], [1, 1.12, 0.7]) }],
  }));

  if (done) return null;
  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      <Animated.View style={[styles.panel, { left: -width * 0.3, width: width * 1.6, backgroundColor: splash.background }, panelStyle]} />
      <View style={styles.center}>
        {bursts.map((burst, index) => (
          <BurstShard key={index} burst={burst} progress={progress} color={burst.color(colors.sport)} />
        ))}
        <Animated.View style={markStyle}>
          <Svg width={splash.imageWidth} height={splash.imageWidth} viewBox="0 0 1024 1024">
            <LogoMark ink={splash.ink} accent={splash.accent} />
          </Svg>
        </Animated.View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  panel: { position: "absolute", top: -40, bottom: -40 },
  center: { position: "absolute", top: 0, right: 0, bottom: 0, left: 0, alignItems: "center", justifyContent: "center" },
  shard: { position: "absolute" },
});
