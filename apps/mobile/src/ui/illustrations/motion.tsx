import type { ReactNode } from "react";
import type { StyleProp, ViewStyle } from "react-native";
import Animated, { useAnimatedStyle } from "react-native-reanimated";
import Svg, { Polygon } from "react-native-svg";
import { useLoop } from "@/ui/motion";

interface DriftProps {
  readonly children: ReactNode;
  readonly duration: number;
  readonly lift: number;
  readonly turn?: number;
  readonly delay?: number;
  readonly style?: StyleProp<ViewStyle>;
}

/** Floats its content up and down, with an optional sway, forever. */
export function Drift({ children, duration, lift, turn = 0, delay = 0, style }: DriftProps) {
  const loop = useLoop(duration, delay);
  const animated = useAnimatedStyle(() => {
    const wave = Math.sin(loop.value * Math.PI * 2);
    return { transform: [{ translateY: wave * lift }, { rotate: `${wave * turn}deg` }] };
  });
  return (
    <Animated.View pointerEvents="none" style={[style, animated]}>
      {children}
    </Animated.View>
  );
}

interface StreakProps {
  readonly children: ReactNode;
  readonly duration: number;
  readonly travel: number;
  readonly delay?: number;
  readonly style?: StyleProp<ViewStyle>;
}

/** Slides its content backwards while fading it, like speed lines behind a moving athlete. */
export function Streak({ children, duration, travel, delay = 0, style }: StreakProps) {
  const loop = useLoop(duration, delay);
  const animated = useAnimatedStyle(() => ({
    opacity: loop.value === 0 ? 1 : Math.sin(loop.value * Math.PI),
    transform: [{ translateX: -loop.value * travel }],
  }));
  return (
    <Animated.View pointerEvents="none" style={[style, animated]}>
      {children}
    </Animated.View>
  );
}

export type ShardShape = "slab" | "triangle" | "diamond";

interface ShardProps {
  readonly shape: ShardShape;
  readonly color: string;
  readonly size: number;
}

export function Shard({ shape, color, size }: ShardProps) {
  const points = shardPoints(shape, size);
  return (
    <Svg width={size} height={size}>
      <Polygon points={points} fill={color} />
    </Svg>
  );
}

function shardPoints(shape: ShardShape, size: number): string {
  const s = size;
  switch (shape) {
    case "slab":
      return `${s * 0.35},0 ${s},0 ${s * 0.65},${s} 0,${s}`;
    case "triangle":
      return `0,${s} ${s * 0.55},0 ${s},${s * 0.8}`;
    case "diamond":
      return `${s / 2},0 ${s},${s / 2} ${s / 2},${s} 0,${s / 2}`;
    default: {
      const unreachable: never = shape;
      throw new Error(`Unhandled shard ${String(unreachable)}`);
    }
  }
}
