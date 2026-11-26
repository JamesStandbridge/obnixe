import { useEffect, useMemo } from "react";
import { StyleSheet, View } from "react-native";
import Animated, { Easing, useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import type { SharedValue } from "react-native-reanimated";
import { Shard } from "@/ui/illustrations/motion";
import type { ShardShape } from "@/ui/illustrations/motion";
import { useTheme } from "@/ui/theme";

interface Piece {
  readonly angle: number;
  readonly distance: number;
  readonly spin: number;
  readonly size: number;
  readonly color: string;
  readonly shape: ShardShape;
}

const shapes: readonly ShardShape[] = ["slab", "triangle", "diamond"];
const pieceCount = 34;
const duration = 1900;

function seeded(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

function ConfettiPiece({ piece, progress, originX, originY }: { readonly piece: Piece; readonly progress: SharedValue<number>; readonly originX: number; readonly originY: number }) {
  const style = useAnimatedStyle(() => {
    const t = progress.value;
    const burst = 1 - (1 - Math.min(1, t * 1.6)) ** 3;
    const x = originX + Math.cos(piece.angle) * piece.distance * burst;
    const y = originY + Math.sin(piece.angle) * piece.distance * burst + 260 * t * t;
    return {
      opacity: t < 0.75 ? 1 : 1 - (t - 0.75) / 0.25,
      transform: [{ translateX: x }, { translateY: y }, { rotate: `${piece.spin * t}deg` }],
    };
  });
  return (
    <Animated.View style={[styles.piece, style]}>
      <Shard shape={piece.shape} color={piece.color} size={piece.size} />
    </Animated.View>
  );
}

interface ConfettiProps {
  readonly width: number;
  readonly originY: number;
}

/** A single burst of geometric confetti from the top centre, skipped when reduced motion is on. */
export function Confetti({ width, originY }: ConfettiProps) {
  const { colors, reduceMotion } = useTheme();
  const progress = useSharedValue(0);
  const pieces = useMemo<Piece[]>(() => {
    const random = seeded(7);
    const palette = [colors.brand, colors.sport.run, colors.sport.strength, colors.sport.climb, colors.sport.swim, colors.sport.yoga, colors.brand];
    return Array.from({ length: pieceCount }, () => ({
      angle: -Math.PI * (0.08 + random() * 0.84),
      distance: 90 + random() * 170,
      spin: (random() - 0.5) * 900,
      size: 8 + random() * 10,
      color: palette[Math.floor(random() * palette.length)] ?? colors.brand,
      shape: shapes[Math.floor(random() * shapes.length)] ?? "slab",
    }));
  }, [colors]);

  useEffect(() => {
    if (reduceMotion) return;
    progress.value = withTiming(1, { duration, easing: Easing.out(Easing.quad) });
  }, [reduceMotion, progress]);

  if (reduceMotion) return null;
  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      {pieces.map((piece, index) => (
        <ConfettiPiece key={index} piece={piece} progress={progress} originX={width / 2} originY={originY} />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  piece: { position: "absolute", left: 0, top: 0 },
});
