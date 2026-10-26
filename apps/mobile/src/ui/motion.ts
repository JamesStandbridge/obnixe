import { useRef } from "react";
import { Animated, Easing } from "react-native";
import { useTheme } from "@/ui/theme";

export const easeOut = Easing.bezier(0.2, 0.8, 0.2, 1);

export interface PressScale {
  readonly scale: Animated.Value;
  readonly onPressIn: () => void;
  readonly onPressOut: () => void;
}

export function usePressScale(pressed: number): PressScale {
  const { reduceMotion } = useTheme();
  const scale = useRef(new Animated.Value(1)).current;
  const animate = (toValue: number): void => {
    if (reduceMotion) return;
    Animated.spring(scale, { toValue, speed: 40, bounciness: 8, useNativeDriver: true }).start();
  };
  return { scale, onPressIn: () => animate(pressed), onPressOut: () => animate(1) };
}
