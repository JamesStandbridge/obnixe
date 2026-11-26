import { useEffect, useState } from "react";
import {
  cancelAnimation,
  Easing,
  FadeInDown,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withRepeat,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import type { AnimatedStyle, SharedValue } from "react-native-reanimated";
import type { ViewStyle } from "react-native";
import { useTheme } from "@/ui/theme";
import { durations } from "@/ui/tokens";

export const easeOut = Easing.bezier(0.2, 0.8, 0.2, 1);

export const springs = {
  press: { damping: 15, stiffness: 420, mass: 0.6 },
  settle: { damping: 18, stiffness: 180, mass: 0.9 },
  bounce: { damping: 11, stiffness: 160, mass: 0.8 },
} as const;

export interface PressScale {
  readonly style: AnimatedStyle<ViewStyle>;
  readonly onPressIn: () => void;
  readonly onPressOut: () => void;
}

export function usePressScale(pressed: number): PressScale {
  const { reduceMotion } = useTheme();
  const scale = useSharedValue(1);
  const style = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));
  const animate = (toValue: number): void => {
    if (reduceMotion) return;
    scale.value = withSpring(toValue, springs.press);
  };
  return { style, onPressIn: () => animate(pressed), onPressOut: () => animate(1) };
}

const revealStep = 55;
const revealSteps = 8;

/** Entering animation for the blocks of a screen, staggered by their position. */
export function reveal(index: number): FadeInDown {
  return FadeInDown.delay(Math.min(index, revealSteps) * revealStep)
    .duration(durations.reveal)
    .easing(easeOut);
}

/** A value that runs from 0 to 1 over and over, frozen at 0 when reduced motion is on. */
export function useLoop(duration: number, delay = 0): SharedValue<number> {
  const { reduceMotion } = useTheme();
  const progress = useSharedValue(0);
  useEffect(() => {
    if (reduceMotion) {
      progress.value = 0;
      return;
    }
    progress.value = withDelay(delay, withRepeat(withTiming(1, { duration, easing: Easing.linear }), -1, false));
    return () => cancelAnimation(progress);
  }, [duration, delay, reduceMotion, progress]);
  return progress;
}

/** A value that springs to its target whenever it changes, starting from `from` on mount. */
export function useSpringTo(target: number, from = 0): SharedValue<number> {
  const { reduceMotion } = useTheme();
  const value = useSharedValue(reduceMotion ? target : from);
  useEffect(() => {
    value.value = reduceMotion ? target : withSpring(target, springs.settle);
  }, [target, reduceMotion, value]);
  return value;
}

/** A value that eases to its target whenever it changes, starting from `from` on mount. */
export function useTimingTo(target: number, duration = 700, from = 0): SharedValue<number> {
  const { reduceMotion } = useTheme();
  const value = useSharedValue(reduceMotion ? target : from);
  useEffect(() => {
    value.value = reduceMotion ? target : withTiming(target, { duration, easing: easeOut });
  }, [target, duration, reduceMotion, value]);
  return value;
}

/** An integer that counts up to its target, for figures that should feel earned. */
export function useCountUp(target: number, duration = 650): number {
  const { reduceMotion } = useTheme();
  const [shown, setShown] = useState(reduceMotion ? target : 0);
  useEffect(() => {
    if (reduceMotion) {
      setShown(target);
      return;
    }
    let frame = 0;
    const start = Date.now();
    const tick = (): void => {
      const elapsed = Math.min(1, (Date.now() - start) / duration);
      const eased = 1 - (1 - elapsed) ** 3;
      setShown(Math.round(target * eased));
      if (elapsed < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [target, duration, reduceMotion]);
  return shown;
}
