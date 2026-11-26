import { useMemo, useRef, useState } from "react";
import { StyleSheet, View } from "react-native";
import type { LayoutChangeEvent } from "react-native";
import Svg, { Defs, LinearGradient, Rect, Stop } from "react-native-svg";
import { metricColumn } from "@obnixe/core";
import type { HeartRateZoneBounds } from "@obnixe/core";
import { AttributionButton } from "@/features/maps/MapControls";
import { MapSurface } from "@/features/maps/MapSurface";
import type { LngLat, MapCamera, MapOverlay, MapView } from "@/features/maps/surface";
import { useMapBase, useMapStyleSetting } from "@/features/maps/useMapBase";
import { fitCamera, metersPerPixel } from "@/features/maps/viewport";
import { activityCursorSourceId, activityLayers, activityMarksSourceId, activityTrackSourceId, coloringRamp } from "@/features/recordings/activityLayers";
import type { ActivityLayerColors } from "@/features/recordings/activityLayers";
import { paceFigure, speedFigure } from "@/features/recordings/format";
import { trackPalettes } from "@/features/recordings/palette";
import { colorScale, cursorPoint, metricValue, progressValue, TrackIndex, trackGeometry, trackLines, trackMarks } from "@/features/recordings/trackMap";
import type { ColorScale, TrackColoring } from "@/features/recordings/trackMap";
import type { RecordedActivity } from "@/features/recordings/useRecordedActivity";
import { FilterChips } from "@/features/stats/parts";
import type { ChipOption } from "@/features/stats/parts";
import { formatInteger, formatSigned } from "@/format/numbers";
import { Text } from "@/ui/Text";
import { useTheme } from "@/ui/theme";
import { fonts, radii } from "@/ui/tokens";

const mapHeight = 320;
const framePadding = 36;
const maxFitZoom = 16;
const touchTolerancePx = 24;

interface ActivityMapProps {
  readonly activity: RecordedActivity;
  readonly cursor: number | null;
  readonly onCursor: (index: number | null) => void;
}

interface Coloring {
  readonly scale: ColorScale | null;
  readonly values: ArrayLike<number> | null;
}

function coloringOptions(activity: RecordedActivity): readonly ChipOption<TrackColoring>[] {
  const options: ChipOption<TrackColoring>[] = [{ value: "progress", label: "Parcours" }];
  options.push(activity.profile.primary === "pace" ? { value: "pace", label: "Allure" } : { value: "speed", label: "Vitesse" });
  if (activity.processed.summary.ascentMm !== null) options.push({ value: "grade", label: "Pente" }, { value: "altitude", label: "Altitude" });
  if (activity.zones !== null) options.push({ value: "heart_rate", label: "Zones FC" });
  return options;
}

function coloringOf(activity: RecordedActivity, coloring: TrackColoring): Coloring {
  const { processed, profile, track } = activity;
  switch (coloring) {
    case "progress":
      return { scale: null, values: null };
    case "pace":
    case "speed": {
      const values = metricColumn(processed, profile, track.samples.heartRate, "speed");
      return { scale: colorScale(coloring, values), values };
    }
    case "grade":
      return { scale: colorScale("grade", processed.series.grade), values: processed.series.grade };
    case "altitude":
      return { scale: colorScale("altitude", processed.series.altitude), values: processed.series.altitude };
    case "heart_rate":
      return { scale: { kind: "zones", range: { min: 0, max: 5 } }, values: metricColumn(processed, profile, track.samples.heartRate, "heart_rate") };
    default: {
      const unreachable: never = coloring;
      return unreachable;
    }
  }
}

function legendText(activity: RecordedActivity, coloring: Exclude<TrackColoring, "progress" | "heart_rate">, value: number): string {
  switch (coloring) {
    case "pace": {
      const figure = paceFigure(activity.profile.pacePerMeters / Math.max(value, 0.1), activity.profile.pacePerMeters);
      return `${figure.value} ${figure.unit}`;
    }
    case "speed": {
      const figure = speedFigure(value);
      return `${figure.value} ${figure.unit}`;
    }
    case "grade":
      return `${formatSigned(value * 100, 0)} %`;
    case "altitude":
      return `${formatInteger(value)} m`;
    default: {
      const unreachable: never = coloring;
      return unreachable;
    }
  }
}

/** The track on the map (`MAP-020`..`MAP-022`): framed on its extent, colored on demand, synchronized with the charts. */
export function ActivityMap({ activity, cursor, onCursor }: ActivityMapProps) {
  const { colors, name } = useTheme();
  const base = useMapBase(activity.saved.session.sport);
  const mapStyle = useMapStyleSetting();
  const [coloring, setColoring] = useState<TrackColoring>("progress");
  const [camera, setCamera] = useState<MapCamera | null>(null);
  const zoom = useRef(12);
  const { processed, mask } = activity;
  const sport = activity.saved.session.sport;

  const geometry = useMemo(() => trackGeometry(processed, mask), [processed, mask]);
  const index = useMemo(() => new TrackIndex(processed, geometry.kept), [processed, geometry]);
  const options = useMemo(() => coloringOptions(activity), [activity]);
  const shown = options.some((option) => option.value === coloring) ? coloring : "progress";
  const colored = useMemo(() => coloringOf(activity, shown), [activity, shown]);
  const layerColors = useMemo<ActivityLayerColors>(
    () => ({ from: colors.sportDeep[sport], to: colors.sport[sport], mark: colors.mark, text: colors.text, palette: trackPalettes[name] }),
    [colors, sport, name],
  );

  const lines = useMemo(() => {
    const value = colored.scale === null || colored.values === null ? progressValue(processed) : metricValue(colored.values, colored.scale, activity.zones?.zones ?? []);
    return trackLines(processed, geometry, value);
  }, [processed, geometry, colored, activity.zones]);
  const marks = useMemo(() => trackMarks(processed, processed.laps, geometry), [processed, geometry]);
  const cursorData = useMemo(() => cursorPoint(processed, geometry, cursor), [processed, geometry, cursor]);
  const layers = useMemo(() => activityLayers(layerColors, name, shown, mapStyle === "obnixe_outdoor"), [layerColors, name, shown, mapStyle]);
  const overlays = useMemo<MapOverlay[]>(
    () => [
      { id: activityTrackSourceId, data: lines, lineMetrics: false, layers: layers.filter((layer) => "source" in layer && layer.source === activityTrackSourceId) },
      { id: activityMarksSourceId, data: marks, lineMetrics: false, layers: layers.filter((layer) => "source" in layer && layer.source === activityMarksSourceId) },
      { id: activityCursorSourceId, data: cursorData, lineMetrics: false, layers: layers.filter((layer) => "source" in layer && layer.source === activityCursorSourceId) },
    ],
    [lines, marks, cursorData, layers],
  );

  const onLayout = (event: LayoutChangeEvent): void => {
    if (camera !== null || geometry.bounds === null) return;
    const { width, height } = event.nativeEvent.layout;
    const fitted = fitCamera(geometry.bounds, { width, height }, framePadding, maxFitZoom);
    zoom.current = fitted.zoom;
    setCamera(fitted);
  };

  const onPress = (point: LngLat): void => {
    const tolerance = touchTolerancePx * metersPerPixel(point[1], zoom.current);
    onCursor(index.nearest(point[1], point[0], tolerance));
  };

  const onViewChanged = (view: MapView): void => {
    zoom.current = view.zoom;
  };

  return (
    <View style={styles.root}>
      <View style={[styles.frame, { borderColor: colors.line, backgroundColor: colors.surface }]} onLayout={onLayout}>
        {camera === null ? null : (
          <MapSurface mapStyle={base.style} fallbackStyle={base.fallback} initialCamera={camera} overlays={overlays} onPress={onPress} onViewChanged={onViewChanged} />
        )}
        {mask === null ? null : (
          <View style={[styles.badge, { backgroundColor: colors.surface, borderColor: colors.line }]} pointerEvents="none">
            <Text variant="caption" tone="secondary">
              Zones masquées
            </Text>
          </View>
        )}
        <View style={styles.attribution}>
          <AttributionButton attribution={base.attribution} />
        </View>
      </View>
      {options.length > 1 ? <FilterChips label="Couleur de la trace" options={options} value={shown} onChange={setColoring} /> : null}
      <Legend activity={activity} coloring={shown} scale={colored.scale} colors={layerColors} />
    </View>
  );
}

interface LegendProps {
  readonly activity: RecordedActivity;
  readonly coloring: TrackColoring;
  readonly scale: ColorScale | null;
  readonly colors: ActivityLayerColors;
}

function Legend({ activity, coloring, scale, colors }: LegendProps) {
  if (coloring === "progress" || scale === null) return null;
  if (coloring === "heart_rate") return <ZoneLegend zones={activity.zones?.zones ?? []} palette={colors.palette.zones} />;
  const ramp = coloringRamp(coloring, colors);
  return (
    <View style={styles.legend} accessibilityLabel={`De ${legendText(activity, coloring, scale.range.min)} à ${legendText(activity, coloring, scale.range.max)}`}>
      <Text variant="caption" tone="secondary" style={styles.legendLabel}>
        {legendText(activity, coloring, scale.range.min)}
      </Text>
      <Svg style={styles.legendBar} height={8} preserveAspectRatio="none" viewBox="0 0 100 8">
        <Defs>
          <LinearGradient id="activity-legend" x1="0" y1="0" x2="1" y2="0">
            {ramp.map((color, position) => (
              <Stop key={color} offset={ramp.length === 1 ? 0 : position / (ramp.length - 1)} stopColor={color} />
            ))}
          </LinearGradient>
        </Defs>
        <Rect x={0} y={0} width={100} height={8} rx={4} fill="url(#activity-legend)" />
      </Svg>
      <Text variant="caption" tone="secondary" style={styles.legendLabel}>
        {legendText(activity, coloring, scale.range.max)}
      </Text>
    </View>
  );
}

interface ZoneLegendProps {
  readonly zones: readonly HeartRateZoneBounds[];
  readonly palette: readonly string[];
}

function ZoneLegend({ zones, palette }: ZoneLegendProps) {
  return (
    <View style={styles.zones}>
      {zones.map((zone) => (
        <View key={zone.zone} style={styles.zone}>
          <View style={[styles.zoneSwatch, { backgroundColor: palette[zone.zone - 1] }]} />
          <Text variant="caption" tone="secondary">{`Z${zone.zone} · ${formatInteger(zone.minBpm)}+`}</Text>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { gap: 4 },
  frame: { height: mapHeight, borderRadius: radii.panel, borderWidth: 1, overflow: "hidden" },
  attribution: { position: "absolute", right: 8, bottom: 8 },
  badge: { position: "absolute", left: 8, top: 8, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 8, borderWidth: 1 },
  legend: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 2 },
  legendLabel: { fontFamily: fonts.figure600 },
  legendBar: { flex: 1 },
  zones: { flexDirection: "row", flexWrap: "wrap", gap: 12, paddingHorizontal: 2 },
  zone: { flexDirection: "row", alignItems: "center", gap: 5 },
  zoneSwatch: { width: 10, height: 10, borderRadius: 3 },
});
