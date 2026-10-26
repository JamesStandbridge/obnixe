import { useState } from "react";
import { View } from "react-native";
import Svg, { Circle, Path } from "react-native-svg";
import { useTheme } from "@/ui/theme";

interface SparklineProps {
  readonly values: readonly number[];
  readonly height?: number;
}

export function Sparkline({ values, height = 44 }: SparklineProps) {
  const { colors } = useTheme();
  const [width, setWidth] = useState(0);
  const inset = 4;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const points = values.map((value, index) => ({
    x: inset + (values.length === 1 ? (width - 2 * inset) / 2 : (index / (values.length - 1)) * (width - 2 * inset)),
    y: inset + (1 - (value - min) / span) * (height - 2 * inset),
  }));
  const path = points.map((point, index) => `${index === 0 ? "M" : "L"}${point.x.toFixed(1)},${point.y.toFixed(1)}`).join("");
  const last = points.at(-1);
  return (
    <View style={{ height }} onLayout={(event) => setWidth(event.nativeEvent.layout.width)} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      {width === 0 || last === undefined ? null : (
        <Svg width={width} height={height}>
          {points.length > 1 ? <Path d={path} fill="none" stroke={colors.text2} strokeWidth={1.75} strokeLinejoin="round" strokeLinecap="round" /> : null}
          <Circle cx={last.x} cy={last.y} r={3.5} fill={colors.mark} />
        </Svg>
      )}
    </View>
  );
}
