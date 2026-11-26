import { memo, useLayoutEffect, useMemo, useRef, useState } from "react";
import { PanResponder, StyleSheet, View } from "react-native";
import type { GestureResponderEvent, HostInstance, LayoutChangeEvent } from "react-native";
import Svg, { Circle, Line, Path, Rect, Text as SvgText } from "react-native-svg";
import { axisAtIndex, axisColumn, axisLength, chartSeries, indexAtAxis, metricColumn, valueAt } from "@obnixe/core";
import type { ChartAxis, ChartMetric, ChartSeries, HeartRateZoneBounds, ValueRange } from "@obnixe/core";
import { areaPath, axisTicks, linePath, paddedRange, project, unproject, valueTicks } from "@/features/recordings/chartGeometry";
import type { PlotScale } from "@/features/recordings/chartGeometry";
import { paceFigure, speedFigure } from "@/features/recordings/format";
import { trackPalettes } from "@/features/recordings/palette";
import type { RecordedActivity } from "@/features/recordings/useRecordedActivity";
import { formatDuration } from "@/features/stats/format";
import { formatClock } from "@/format/durations";
import { formatInteger, formatNumber } from "@/format/numbers";
import { Segmented } from "@/ui/Controls";
import { Text } from "@/ui/Text";
import { useTheme } from "@/ui/theme";
import { fonts, wash } from "@/ui/tokens";

const panelHeight = 92;
const panelTop = 8;
const panelBottom = panelHeight - 6;
const gutter = 44;
const axisHeight = 20;
/** `SUM-002`: at most two points per horizontal pixel. */
const pointsPerPixel = 2;

const axisOptions = [
  { value: "distance", label: "Distance" },
  { value: "time", label: "Temps" },
] as const;

interface Panel {
  readonly metric: ChartMetric;
  readonly label: string;
  readonly color: string;
  readonly series: ChartSeries;
  readonly column: Float64Array;
  readonly y: PlotScale;
  readonly ticks: readonly number[];
  readonly zones: readonly HeartRateZoneBounds[];
}

function metricLabel(metric: ChartMetric): string {
  switch (metric) {
    case "altitude":
      return "Altitude";
    case "pace":
      return "Allure";
    case "speed":
      return "Vitesse";
    case "heart_rate":
      return "Fréquence cardiaque";
    default: {
      const unreachable: never = metric;
      return unreachable;
    }
  }
}

function tickText(metric: ChartMetric, value: number): string {
  switch (metric) {
    case "altitude":
    case "heart_rate":
      return formatInteger(value);
    case "pace":
      return formatClock(value);
    case "speed":
      return formatNumber(value * 3.6, 0);
    default: {
      const unreachable: never = metric;
      return unreachable;
    }
  }
}

function readout(metric: ChartMetric, pacePerMeters: number, value: number): string {
  if (!Number.isFinite(value)) return "–";
  switch (metric) {
    case "altitude":
      return `${formatInteger(value)} m`;
    case "heart_rate":
      return `${formatInteger(value)} bpm`;
    case "pace": {
      const figure = paceFigure(value, pacePerMeters);
      return `${figure.value} ${figure.unit}`;
    }
    case "speed": {
      const figure = speedFigure(value);
      return `${figure.value} ${figure.unit}`;
    }
    default: {
      const unreachable: never = metric;
      return unreachable;
    }
  }
}

function displayedRange(metric: ChartMetric, range: ValueRange): ValueRange {
  switch (metric) {
    case "altitude":
      return paddedRange(range, 30, 0.08);
    case "heart_rate":
      return paddedRange(range, 20, 0.06);
    case "pace":
      return paddedRange(range, 30, 0.04);
    case "speed":
      return { min: 0, max: Math.max(range.max * 1.06, 1) };
    default: {
      const unreachable: never = metric;
      return unreachable;
    }
  }
}

function axisText(axis: ChartAxis, value: number): string {
  switch (axis) {
    case "distance":
      return value < 1000 ? `${formatInteger(value)} m` : `${formatNumber(value / 1000, 1)} km`;
    case "time":
      return formatDuration(value / 1000);
    default: {
      const unreachable: never = axis;
      return unreachable;
    }
  }
}

interface ActivityChartsProps {
  readonly activity: RecordedActivity;
  readonly cursor: number | null;
  readonly onCursor: (index: number | null) => void;
}

/**
 * Altitude, pace or speed, and heart rate on one shared axis (`SUM-002`), reduced to two points per pixel; a finger on the
 * charts moves the cursor on the map (`MAP-022`).
 */
export function ActivityCharts({ activity, cursor, onCursor }: ActivityChartsProps) {
  const { colors, name } = useTheme();
  const [axis, setAxis] = useState<ChartAxis>("distance");
  const [width, setWidth] = useState(0);
  const container = useRef<HostInstance>(null);
  const origin = useRef(0);
  const { processed, profile, track } = activity;
  const sport = activity.saved.session.sport;
  const plotWidth = Math.max(0, width - gutter);

  const columns = useMemo(() => {
    const metrics: ChartMetric[] = [];
    if (processed.summary.ascentMm !== null) metrics.push("altitude");
    metrics.push(profile.primary === "pace" ? "pace" : "speed");
    if (track.samples.heartRate.length > 0) metrics.push("heart_rate");
    return metrics.map((metric) => ({ metric, column: metricColumn(processed, profile, track.samples.heartRate, metric) }));
  }, [processed, profile, track]);

  const axisValues = useMemo(() => axisColumn(processed, axis), [processed, axis]);
  const length = axisLength(processed, axis);
  const x = useMemo((): PlotScale => ({ min: 0, max: Math.max(length, 1), from: 0, to: plotWidth }), [length, plotWidth]);

  const panels = useMemo((): readonly Panel[] => {
    if (plotWidth === 0) return [];
    const metricColors: Readonly<Record<ChartMetric, string>> = { altitude: colors.text2, pace: colors.sport[sport], speed: colors.sport[sport], heart_rate: trackPalettes[name].zones[4] ?? colors.stop };
    return columns.flatMap(({ metric, column }): Panel[] => {
      const series = chartSeries(axisValues, column, metric, Math.round(plotWidth * pointsPerPixel));
      if (series === null) return [];
      const range = displayedRange(metric, series.range);
      const y: PlotScale = metric === "pace" ? { ...range, from: panelTop, to: panelBottom } : { ...range, from: panelBottom, to: panelTop };
      return [{ metric, label: metricLabel(metric), color: metricColors[metric], series, column, y, ticks: valueTicks(range, 2), zones: metric === "heart_rate" ? (activity.zones?.zones ?? []) : [] }];
    });
  }, [columns, axisValues, plotWidth, colors, sport, name, activity.zones]);

  const latest = useRef({ axisValues, x, onCursor });
  useLayoutEffect(() => {
    latest.current = { axisValues, x, onCursor };
  });
  const select = (pageX: number): void => {
    const state = latest.current;
    const position = unproject(state.x, Math.min(state.x.to, Math.max(0, pageX - origin.current)));
    state.onCursor(indexAtAxis(state.axisValues, position));
  };
  const scrubbing = useRef(false);
  const responder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: (_, gesture) => Math.abs(gesture.dx) > 6 && Math.abs(gesture.dx) > Math.abs(gesture.dy),
        onPanResponderGrant: () => {
          scrubbing.current = false;
          container.current?.measureInWindow((left: number) => {
            origin.current = left;
          });
        },
        onPanResponderMove: (event: GestureResponderEvent, gesture) => {
          if (!scrubbing.current && Math.abs(gesture.dx) > 6 && Math.abs(gesture.dx) > Math.abs(gesture.dy)) scrubbing.current = true;
          if (scrubbing.current) select(event.nativeEvent.pageX);
        },
        onPanResponderRelease: (event: GestureResponderEvent) => {
          if (!scrubbing.current) select(event.nativeEvent.pageX);
          scrubbing.current = false;
        },
        onPanResponderTerminationRequest: () => !scrubbing.current,
      }),
    [],
  );

  const onLayout = (event: LayoutChangeEvent): void => {
    setWidth(Math.round(event.nativeEvent.layout.width));
    container.current?.measureInWindow((left: number) => {
      origin.current = left;
    });
  };

  const cursorX = cursor === null || plotWidth === 0 ? null : project(x, axisAtIndex(axisValues, cursor));
  const ticks = plotWidth === 0 ? [] : axisTicks(axis, length, plotWidth, 64);

  return (
    <View style={styles.root}>
      <Segmented options={axisOptions} value={axis} onChange={setAxis} />
      <View ref={container} onLayout={onLayout} style={styles.charts} accessibilityLabel="Graphiques de l'activité : balaye pour placer le curseur sur la carte" {...responder.panHandlers}>
        {panels.map((panel) => (
          <View key={panel.metric} style={styles.panel}>
            <View style={styles.panelHead}>
              <Text variant="caption" tone="secondary">
                {panel.label}
              </Text>
              <Text style={[styles.readout, { color: cursor === null ? colors.text3 : colors.text }]}>{cursor === null ? " " : readout(panel.metric, profile.pacePerMeters, valueAt(panel.column, cursor))}</Text>
            </View>
            <View>
              <PanelPlot panel={panel} x={x} width={width} />
              {cursorX === null ? null : (
                <Svg style={StyleSheet.absoluteFill} width={width} height={panelHeight} pointerEvents="none">
                  <Line x1={cursorX} x2={cursorX} y1={0} y2={panelHeight} stroke={colors.text2} strokeWidth={1} />
                  <CursorDot panel={panel} x={cursorX} value={cursor === null ? Number.NaN : valueAt(panel.column, cursor)} fill={colors.bg} />
                </Svg>
              )}
            </View>
          </View>
        ))}
        {panels.length === 0 ? null : (
          <Svg width={width} height={axisHeight}>
            {ticks.map((tick) => (
              <SvgText key={tick} x={project(x, tick)} y={14} textAnchor="middle" fill={colors.text3} fontFamily={fonts.figure600} fontSize={11}>
                {axisText(axis, tick)}
              </SvgText>
            ))}
          </Svg>
        )}
      </View>
    </View>
  );
}

interface CursorDotProps {
  readonly panel: Panel;
  readonly x: number;
  readonly value: number;
  readonly fill: string;
}

function CursorDot({ panel, x, value, fill }: CursorDotProps) {
  if (!Number.isFinite(value)) return null;
  const top = Math.min(panel.y.from, panel.y.to);
  const bottom = Math.max(panel.y.from, panel.y.to);
  return <Circle cx={x} cy={Math.min(bottom, Math.max(top, project(panel.y, value)))} r={4.5} fill={fill} stroke={panel.color} strokeWidth={2.5} />;
}

interface PanelPlotProps {
  readonly panel: Panel;
  readonly x: PlotScale;
  readonly width: number;
}

/** The static part of a panel, drawn again only when the axis, the width or the data change. */
const PanelPlot = memo(function PanelPlot({ panel, x, width }: PanelPlotProps) {
  const { colors, name } = useTheme();
  const zonePalette = trackPalettes[name].zones;
  const line = useMemo(() => linePath(panel.series.line, x, panel.y), [panel, x]);
  const area = useMemo(() => (panel.metric === "altitude" ? areaPath(panel.series.line, x, panel.y, panelBottom) : null), [panel, x]);
  const top = Math.min(panel.y.from, panel.y.to);
  const bottom = Math.max(panel.y.from, panel.y.to);
  return (
    <Svg width={width} height={panelHeight}>
      {panel.zones.map((zone) => {
        const from = Math.min(bottom, Math.max(top, project(panel.y, zone.minBpm)));
        const to = Math.min(bottom, Math.max(top, project(panel.y, zone.maxBpm)));
        if (Math.abs(from - to) < 1) return null;
        return <Rect key={zone.zone} x={0} y={Math.min(from, to)} width={x.to} height={Math.abs(from - to)} fill={wash(zonePalette[zone.zone - 1] ?? colors.line, 0.1)} />;
      })}
      {panel.ticks.map((tick) => (
        <Line key={`g${tick}`} x1={0} x2={x.to} y1={project(panel.y, tick)} y2={project(panel.y, tick)} stroke={colors.line} strokeWidth={1} />
      ))}
      {panel.ticks.map((tick) => (
        <SvgText key={`t${tick}`} x={width} y={project(panel.y, tick) + 4} textAnchor="end" fill={colors.text3} fontFamily={fonts.figure600} fontSize={11}>
          {tickText(panel.metric, tick)}
        </SvgText>
      ))}
      {area === null ? null : <Path d={area} fill={wash(panel.color, 0.16)} />}
      <Path d={line} fill="none" stroke={panel.color} strokeWidth={1.75} strokeLinejoin="round" strokeLinecap="round" />
    </Svg>
  );
});

const styles = StyleSheet.create({
  root: { gap: 12 },
  charts: { gap: 6 },
  panel: { gap: 2 },
  panelHead: { flexDirection: "row", justifyContent: "space-between", alignItems: "baseline", paddingRight: gutter },
  readout: { fontFamily: fonts.figure700, fontSize: 14 },
});
