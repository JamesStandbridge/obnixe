import { useState } from "react";
import { StyleSheet, View } from "react-native";
import type { LayoutChangeEvent } from "react-native";
import Svg, { Path } from "react-native-svg";
import type { ElevationPoint } from "@obnixe/core";
import { elevationShape } from "@/features/recording/elevation";
import { formatInteger, formatNumber } from "@/format/numbers";
import { Text } from "@/ui/Text";
import { useTheme } from "@/ui/theme";

const chartHeight = 120;
const chartInset = 8;

interface RouteProfileChartProps {
  readonly points: readonly ElevationPoint[];
}

/** The elevation profile of a whole route, in the direction followed (`RTE-001`, `RTE-002`). */
export function RouteProfileChart({ points }: RouteProfileChartProps) {
  const { colors } = useTheme();
  const [width, setWidth] = useState(0);
  const shape = width === 0 ? null : elevationShape(points, width, chartHeight - chartInset * 2);
  const onLayout = (event: LayoutChangeEvent): void => setWidth(event.nativeEvent.layout.width);
  return (
    <View style={[styles.chart, { borderColor: colors.line }]} onLayout={onLayout}>
      {shape === null ? null : (
        <View style={StyleSheet.absoluteFill} accessible accessibilityLabel={`Profil sur ${formatNumber(shape.meters / 1000, 1)} km, de ${formatInteger(shape.lowest)} à ${formatInteger(shape.highest)} m`}>
          <Svg width={width} height={chartHeight}>
            <Path d={shape.area} fill={colors.mark} fillOpacity={0.18} transform={`translate(0 ${chartInset})`} />
            <Path d={shape.line} stroke={colors.mark} strokeWidth={2} strokeLinejoin="round" fill="none" transform={`translate(0 ${chartInset})`} />
          </Svg>
          <Text variant="caption" tone="secondary" style={styles.highest}>
            {`${formatInteger(shape.highest)} m`}
          </Text>
          <Text variant="caption" tone="secondary" style={styles.lowest}>
            {`${formatInteger(shape.lowest)} m`}
          </Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  chart: { height: chartHeight, marginTop: 14, borderBottomWidth: 1 },
  highest: { position: "absolute", top: 0, left: 0 },
  lowest: { position: "absolute", bottom: 4, left: 0 },
});
