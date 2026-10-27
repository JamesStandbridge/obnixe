import { useState } from "react";
import { StyleSheet, View } from "react-native";
import Svg, { Circle, Line, Path } from "react-native-svg";
import { daysBetween } from "@obnixe/core";
import type { WeightPoint } from "@obnixe/core";
import type { LocalDate } from "@obnixe/schema";
import { shortDate } from "@/format/dates";
import { Text } from "@/ui/Text";
import { useTheme } from "@/ui/theme";
import { fonts } from "@/ui/tokens";

interface WeightChartProps {
  readonly points: readonly WeightPoint[];
  readonly start: LocalDate;
  readonly end: LocalDate;
  readonly formatValue: (grams: number) => string;
  readonly accessibilityLabel: string;
}

const height = 112;
const top = 10;
const bottom = 10;
const labelGutter = 40;

export function WeightChart({ points, start, end, formatValue, accessibilityLabel }: WeightChartProps) {
  const { colors } = useTheme();
  const [width, setWidth] = useState(0);
  const span = Math.max(1, daysBetween(start, end));
  const values = points.map((point) => point.grams);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const plotWidth = Math.max(0, width - labelGutter);
  const x = (date: LocalDate): number => 4 + (daysBetween(start, date) / span) * (plotWidth - 8);
  const y = (grams: number): number => top + (1 - (grams - min) / range) * (height - top - bottom);
  const coordinates = points.map((point) => ({ x: x(point.localDate), y: y(point.grams) }));
  const path = coordinates.map((point, index) => `${index === 0 ? "M" : "L"}${point.x.toFixed(1)},${point.y.toFixed(1)}`).join("");
  const last = coordinates.at(-1);
  const flat = max === min;
  return (
    <View accessible accessibilityRole="image" accessibilityLabel={accessibilityLabel}>
      <View style={{ height }} onLayout={(event) => setWidth(event.nativeEvent.layout.width)}>
        {width === 0 || last === undefined ? null : (
          <>
            <Svg width={width} height={height}>
              <Line x1={0} x2={plotWidth} y1={y(max)} y2={y(max)} stroke={colors.controlBorder} strokeWidth={1} strokeDasharray="2 4" />
              {flat ? null : <Line x1={0} x2={plotWidth} y1={y(min)} y2={y(min)} stroke={colors.controlBorder} strokeWidth={1} strokeDasharray="2 4" />}
              <Path d={path} fill="none" stroke={colors.mark} strokeWidth={1.75} strokeLinejoin="round" strokeLinecap="round" />
              {coordinates.slice(0, -1).map((point) => (
                <Circle key={`${point.x}-${point.y}`} cx={point.x} cy={point.y} r={1.6} fill={colors.mark} />
              ))}
              <Circle cx={last.x} cy={last.y} r={5.5} fill={colors.bg} />
              <Circle cx={last.x} cy={last.y} r={3.75} fill={colors.mark} />
            </Svg>
            <Text style={[styles.guide, { top: y(max) - 8 }]} tone="secondary">
              {formatValue(max)}
            </Text>
            {flat ? null : (
              <Text style={[styles.guide, { top: y(min) - 8 }]} tone="secondary">
                {formatValue(min)}
              </Text>
            )}
          </>
        )}
      </View>
      <View style={[styles.axis, { marginRight: labelGutter }]}>
        <Text variant="caption" tone="tertiary">
          {shortDate(start)}
        </Text>
        <Text variant="caption" tone="tertiary">
          Aujourd'hui
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  guide: { position: "absolute", right: 0, width: labelGutter - 6, textAlign: "right", fontFamily: fonts.figure600, fontSize: 13, lineHeight: 16 },
  axis: { flexDirection: "row", justifyContent: "space-between", marginTop: 4 },
});
