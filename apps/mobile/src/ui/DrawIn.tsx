import { useEffect } from "react";
import type { ReactNode } from "react";
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import { easeOut } from "@/ui/motion";
import { useTheme } from "@/ui/theme";

interface DrawInProps {
  readonly drawKey: string;
  readonly height: number;
  readonly duration?: number;
  readonly children: ReactNode;
}

/** Uncovers a chart from left to right each time `drawKey` changes; children must have a fixed width. */
export function DrawIn({ drawKey, height, duration = 900, children }: DrawInProps) {
  const { reduceMotion } = useTheme();
  const drawn = useSharedValue(reduceMotion ? 1 : 0);
  useEffect(() => {
    if (reduceMotion) {
      drawn.value = 1;
      return;
    }
    drawn.value = 0;
    drawn.value = withTiming(1, { duration, easing: easeOut });
  }, [drawKey, duration, reduceMotion, drawn]);
  const style = useAnimatedStyle(() => ({ width: `${drawn.value * 100}%` }));
  return <Animated.View style={[{ height, overflow: "hidden" }, style]}>{children}</Animated.View>;
}
