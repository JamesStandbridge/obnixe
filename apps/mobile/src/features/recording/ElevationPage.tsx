import { useState } from "react";
import { StyleSheet, View } from "react-native";
import type { LayoutChangeEvent } from "react-native";
import Svg, { Circle, Path } from "react-native-svg";
import type { ElevationPoint } from "@obnixe/core";
import type { SportKey } from "@obnixe/schema";
import { elevationShape } from "@/features/recording/elevation";
import { MetricTile } from "@/features/recording/LiveParts";
import type { MetricText } from "@/features/recording/metrics";
import { formatInteger, formatNumber } from "@/format/numbers";
import { Text } from "@/ui/Text";
import { useTheme } from "@/ui/theme";

interface ElevationPageProps {
  readonly points: readonly ElevationPoint[];
  readonly sport: SportKey;
  readonly altitude: MetricText;
  readonly ascent: MetricText;
  readonly descent: MetricText;
  /** `RTE-003`: with a followed route of known altitude, its whole profile with the position on it. */
  readonly route: RouteElevation | null;
}

export interface RouteElevation {
  readonly points: readonly ElevationPoint[];
  /** Meters along the route. */
  readonly progress: number;
  readonly remainingAscent: MetricText;
}

const chartInset = 8;

/** `UX-002`: the elevation profile so far, or the followed route's, under the altitude and the climbs. */
export function ElevationPage({ points, sport, altitude, ascent, descent, route }: ElevationPageProps) {
  const { colors } = useTheme();
  const [box, setBox] = useState({ width: 0, height: 0 });
  const shape = box.width === 0 ? null : elevationShape(route?.points ?? points, box.width, Math.max(0, box.height - chartInset * 2), route?.progress ?? null);
  const position = shape === null ? null : (shape.marker ?? shape.last);
  const onLayout = (event: LayoutChangeEvent): void => setBox({ width: event.nativeEvent.layout.width, height: event.nativeEvent.layout.height });
  const accent = colors.sport[sport];
  return (
    <View style={styles.root}>
      <View style={styles.figures}>
        <MetricTile caption="Altitude" text={altitude} size={40} minimumScale={0.8} style={styles.figure} />
        <MetricTile caption="D+" text={ascent} size={40} minimumScale={0.8} style={styles.figure} />
        {route === null ? (
          <MetricTile caption="D−" text={descent} size={40} minimumScale={0.8} style={styles.figure} />
        ) : (
          <MetricTile caption="D+ restant" text={route.remainingAscent} size={40} minimumScale={0.8} style={styles.figure} />
        )}
      </View>
      <View style={[styles.chart, { borderColor: colors.line }]} onLayout={onLayout}>
        {shape === null || position === null ? (
          <Text variant="small" tone="secondary" style={styles.empty}>
            Le profil se dessine au fil des mètres.
          </Text>
        ) : (
          <View
            style={StyleSheet.absoluteFill}
            accessible
            accessibilityLabel={`${route === null ? "Profil" : "Profil de l'itinéraire"} sur ${formatNumber(shape.meters / 1000, 1)} km, de ${formatInteger(shape.lowest)} à ${formatInteger(shape.highest)} m`}
          >
            <Svg width={box.width} height={box.height}>
              <Path d={shape.area} fill={accent} fillOpacity={0.18} transform={`translate(0 ${chartInset})`} />
              <Path d={shape.line} stroke={accent} strokeWidth={2.5} strokeLinejoin="round" fill="none" transform={`translate(0 ${chartInset})`} />
              <Circle cx={position.x} cy={position.y + chartInset} r={5} fill={accent} stroke={colors.bg} strokeWidth={2} />
            </Svg>
            <Text variant="caption" tone="secondary" style={styles.highest}>
              {`${formatInteger(shape.highest)} m`}
            </Text>
            <Text variant="caption" tone="secondary" style={styles.lowest}>
              {`${formatInteger(shape.lowest)} m`}
            </Text>
            <Text variant="caption" tone="secondary" style={styles.distance}>
              {`${formatNumber(shape.meters / 1000, 1)} km`}
            </Text>
          </View>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, paddingTop: 14, paddingBottom: 16, gap: 14 },
  figures: { flexDirection: "row", gap: 12 },
  figure: { flex: 1 },
  chart: { flex: 1, minHeight: 160, borderBottomWidth: 1, justifyContent: "center" },
  empty: { textAlign: "center" },
  highest: { position: "absolute", top: 0, left: 0 },
  lowest: { position: "absolute", bottom: 4, left: 0 },
  distance: { position: "absolute", bottom: 4, right: 0 },
});
