import { Text as NativeText } from "react-native";
import type { StyleProp, TextProps as NativeTextProps, TextStyle } from "react-native";
import { useTheme } from "@/ui/theme";
import { type as typeScale } from "@/ui/tokens";
import type { Palette, TypeVariant } from "@/ui/tokens";

export type TextTone = "primary" | "secondary" | "tertiary" | "inverse" | "act";

function toneColor(tone: TextTone, colors: Palette): string {
  switch (tone) {
    case "primary":
      return colors.text;
    case "secondary":
      return colors.text2;
    case "tertiary":
      return colors.text3;
    case "inverse":
      return colors.bg;
    case "act":
      return colors.actInk;
    default: {
      const unreachable: never = tone;
      return unreachable;
    }
  }
}

export interface TextProps extends NativeTextProps {
  readonly variant?: TypeVariant;
  readonly tone?: TextTone;
  readonly style?: StyleProp<TextStyle>;
}

const displayVariants: ReadonlySet<TypeVariant> = new Set<TypeVariant>(["figure", "display"]);

export function Text({ variant = "body", tone = "primary", style, maxFontSizeMultiplier, ...rest }: TextProps) {
  const { colors } = useTheme();
  return (
    <NativeText
      {...rest}
      maxFontSizeMultiplier={maxFontSizeMultiplier ?? (displayVariants.has(variant) ? 1.2 : undefined)}
      style={[typeScale[variant], { color: toneColor(tone, colors), fontVariant: ["tabular-nums"] }, style]}
    />
  );
}
