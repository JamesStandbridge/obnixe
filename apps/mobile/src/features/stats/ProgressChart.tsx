import { useMemo, useRef, useState } from "react";
import { PanResponder, View } from "react-native";
import type { AccessibilityActionEvent, GestureResponderEvent, HostInstance, LayoutChangeEvent } from "react-native";
import Svg, { Circle, Line, Path, Rect, Text as SvgText } from "react-native-svg";
import { addDays, dateParts, daysBetween, localDate, mondayOf } from "@obnixe/core";
import type { ZonePainEvent } from "@obnixe/core";
import { gradeScales } from "@obnixe/schema";
import type { LocalDate } from "@obnixe/schema";
import { useTheme } from "@/ui/theme";
import { fonts } from "@/ui/tokens";
import { monthShort, shortDate } from "@/format/dates";
import type { ChartPoint, Series } from "@/features/stats/progress";

const W = 358;
const PLOT_RIGHT = 320;
const PLOT_TOP = 30;
const PLOT_BOTTOM = 168;
const AXIS_Y = 186;

export interface PainStrip {
  readonly label: string;
  readonly events: readonly ZonePainEvent[];
}

interface ProgressChartProps {
  readonly series: Series;
  readonly points: readonly ChartPoint[];
  readonly from: LocalDate;
  readonly to: LocalDate;
  readonly rangeDays: number;
  readonly selected: number;
  readonly onSelect: (index: number) => void;
  readonly strip: PainStrip | null;
  readonly valueText: string;
}

function niceTicks(min: number, max: number, count: number): number[] {
  const span = max - min || 1;
  const raw = span / count;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((factor) => factor * magnitude).find((candidate) => candidate >= raw) ?? magnitude * 10;
  const start = Math.floor(min / step) * step;
  const end = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let value = start; value <= end + step / 2; value += step) ticks.push(Math.round(value * 100) / 100);
  return ticks;
}

interface TimeTick {
  readonly date: LocalDate;
  readonly label: string;
}

function timeTicks(from: LocalDate, to: LocalDate, rangeDays: number): TimeTick[] {
  const ticks: TimeTick[] = [];
  if (rangeDays <= 28) {
    for (let date = mondayOf(from); date <= to; date = addDays(date, 7)) if (date >= from) ticks.push({ date, label: shortDate(date) });
    return ticks;
  }
  const stride = rangeDays >= 365 ? 2 : 1;
  const start = dateParts(from);
  for (let index = 1; ; index += stride) {
    const date = localDate(start.year, start.month + index, 1);
    if (date > to) break;
    ticks.push({ date, label: monthShort[dateParts(date).month - 1] ?? "" });
  }
  return ticks;
}

interface Scale {
  readonly low: number;
  readonly high: number;
  readonly ticks: readonly number[];
}

function valueScale(series: Series, points: readonly ChartPoint[]): Scale {
  const values = points.map((point) => point.value);
  switch (series.domain.kind) {
    case "fixed": {
      const { min, max } = series.domain;
      return { low: min, high: max, ticks: niceTicks(min, max, 4).filter((tick) => tick >= min && tick <= max) };
    }
    case "grades": {
      const last = gradeScales[series.domain.scale].grades.length - 1;
      const low = Math.max(0, Math.min(...values) - 1);
      const high = Math.min(last, Math.max(...values) + 1);
      return { low, high, ticks: Array.from({ length: high - low + 1 }, (_, index) => low + index) };
    }
    case "auto": {
      const min = series.kind === "bars" ? 0 : Math.min(...values);
      const max = Math.max(...values, series.kind === "bars" ? 1 : -Infinity);
      const ticks = niceTicks(min, max, 3);
      return { low: ticks[0] ?? min, high: ticks[ticks.length - 1] ?? max, ticks };
    }
    default: {
      const unreachable: never = series.domain;
      return unreachable;
    }
  }
}

export function ProgressChart({ series, points, from, to, rangeDays, selected, onSelect, strip, valueText }: ProgressChartProps) {
  const { colors } = useTheme();
  const [width, setWidth] = useState(0);
  const origin = useRef(0);
  const container = useRef<HostInstance>(null);
  const height = strip === null ? 196 : 240;
  const scale = useMemo(() => valueScale(series, points), [series, points]);
  const x = (date: LocalDate): number => (daysBetween(from, date) / rangeDays) * PLOT_RIGHT;
  const invert = series.better === "lower";
  const y = (value: number): number => {
    const ratio = (value - scale.low) / (scale.high - scale.low || 1);
    return invert ? PLOT_TOP + ratio * (PLOT_BOTTOM - PLOT_TOP) : PLOT_BOTTOM - ratio * (PLOT_BOTTOM - PLOT_TOP);
  };

  const latest = useRef({ points, onSelect, selected, width });
  latest.current = { points, onSelect, selected, width };

  const selectAt = (pageX: number): void => {
    const state = latest.current;
    if (state.width === 0 || state.points.length === 0) return;
    const ratio = Math.min(1, Math.max(0, ((pageX - origin.current) / state.width) * (W / PLOT_RIGHT)));
    const day = ratio * rangeDays;
    let nearest = 0;
    state.points.forEach((point, index) => {
      const best = state.points[nearest];
      if (best !== undefined && Math.abs(daysBetween(from, point.date) - day) < Math.abs(daysBetween(from, best.date) - day)) nearest = index;
    });
    if (nearest !== state.selected) state.onSelect(nearest);
  };

  const scrubbing = useRef(false);
  const responder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: (_, gesture) => Math.abs(gesture.dx) > 8 && Math.abs(gesture.dx) > Math.abs(gesture.dy),
        onPanResponderGrant: () => {
          scrubbing.current = false;
          container.current?.measureInWindow((left: number) => {
            origin.current = left;
          });
        },
        onPanResponderMove: (event: GestureResponderEvent, gesture) => {
          if (!scrubbing.current && Math.abs(gesture.dx) > 8 && Math.abs(gesture.dx) > Math.abs(gesture.dy)) scrubbing.current = true;
          if (scrubbing.current) selectAt(event.nativeEvent.pageX);
        },
        onPanResponderRelease: (event: GestureResponderEvent) => {
          if (!scrubbing.current) selectAt(event.nativeEvent.pageX);
          scrubbing.current = false;
        },
        onPanResponderTerminationRequest: () => !scrubbing.current,
      }),
    [from, rangeDays],
  );

  const onLayout = (event: LayoutChangeEvent): void => {
    setWidth(event.nativeEvent.layout.width);
    container.current?.measureInWindow((left: number) => {
      origin.current = left;
    });
  };

  const onAction = (event: AccessibilityActionEvent): void => {
    switch (event.nativeEvent.actionName) {
      case "increment":
        onSelect(Math.min(points.length - 1, selected + 1));
        return;
      case "decrement":
        onSelect(Math.max(0, selected - 1));
        return;
      default:
        return;
    }
  };

  const current = points[selected];
  const barWidth = Math.max(2, (7 / rangeDays) * PLOT_RIGHT - 2);
  const path = points
    .map((point, index) => {
      if (index === 0) return `M${x(point.date)},${y(point.value)}`;
      return series.kind === "step" ? `H${x(point.date)}V${y(point.value)}` : `L${x(point.date)},${y(point.value)}`;
    })
    .join("");
  const showDots = rangeDays < 84;
  const lanes = { session: 214, check_in: 230 } as const;

  return (
    <View
      ref={container}
      onLayout={onLayout}
      style={{ marginTop: 8 }}
      accessible
      accessibilityRole="adjustable"
      accessibilityLabel="Graphique : balaye pour parcourir les points"
      accessibilityValue={{ text: valueText }}
      accessibilityActions={[{ name: "increment" }, { name: "decrement" }]}
      onAccessibilityAction={onAction}
      {...responder.panHandlers}
    >
      <Svg width="100%" height={width === 0 ? 0 : (width * height) / W} viewBox={`0 0 ${W} ${height}`}>
        {scale.ticks.map((tick) => (
          <Line key={`g${tick}`} x1={0} x2={PLOT_RIGHT} y1={y(tick)} y2={y(tick)} stroke={colors.line} strokeWidth={1} />
        ))}
        {scale.ticks.map((tick) => (
          <SvgText key={`t${tick}`} x={W} y={y(tick) + 4} textAnchor="end" fill={colors.text3} fontFamily={fonts.figure600} fontSize={12}>
            {series.tickFormat(tick)}
          </SvgText>
        ))}
        {timeTicks(from, to, rangeDays).map((tick) => (
          <SvgText key={tick.date} x={x(tick.date)} y={AXIS_Y} textAnchor="middle" fill={colors.text3} fontFamily={fonts.figure600} fontSize={12}>
            {tick.label}
          </SvgText>
        ))}
        {series.kind === "bars"
          ? points.map((point, index) => {
              const top = y(point.value);
              const barHeight = Math.max(PLOT_BOTTOM - top, point.value > 0 ? 2 : 0);
              return <Rect key={point.date} x={x(point.date) - barWidth / 2} y={Math.min(top, PLOT_BOTTOM - (point.value > 0 ? 2 : 0))} width={barWidth} height={barHeight} rx={1.5} fill={index === selected ? colors.text : colors.stepDone} />;
            })
          : null}
        {series.kind !== "bars" ? <Path d={path} fill="none" stroke={colors.text} strokeWidth={2} strokeLinejoin={series.kind === "step" ? "miter" : "round"} strokeLinecap={series.kind === "step" ? "square" : "round"} /> : null}
        {series.kind !== "bars"
          ? points.map((point, index) => {
              if (point.isRecord) return null;
              if (point.unreliable) return <Circle key={`u${index}`} cx={x(point.date)} cy={y(point.value)} r={3} fill={colors.bg} stroke={colors.text2} strokeWidth={1.5} />;
              if (showDots) return <Circle key={`d${index}`} cx={x(point.date)} cy={y(point.value)} r={3} fill={colors.text} />;
              return null;
            })
          : null}
        {series.kind !== "bars"
          ? points.map((point, index) => (point.isRecord ? <Rect key={`r${index}`} x={x(point.date) - 3.5} y={y(point.value) - 3.5} width={7} height={7} fill={colors.bg} stroke={colors.text} strokeWidth={2} /> : null))
          : null}
        {current === undefined ? null : (
          <>
            <Line x1={x(current.date)} x2={x(current.date)} y1={PLOT_TOP - 6} y2={PLOT_BOTTOM} stroke={colors.text2} strokeWidth={1} />
            {series.kind === "bars" ? null : <Circle cx={x(current.date)} cy={y(current.value)} r={6} fill={colors.bg} stroke={colors.mark} strokeWidth={2.5} />}
          </>
        )}
        {strip === null ? null : (
          <>
            <SvgText x={0} y={200} fill={colors.text3} fontFamily={fonts.text600} fontSize={11}>
              {strip.label}
            </SvgText>
            <Line x1={0} x2={PLOT_RIGHT} y1={lanes.session} y2={lanes.session} stroke={colors.line} strokeWidth={1} />
            <Line x1={0} x2={PLOT_RIGHT} y1={lanes.check_in} y2={lanes.check_in} stroke={colors.line} strokeWidth={1} />
            {strip.events
              .filter((event) => event.localDate >= from && event.localDate <= to)
              .map((event, index) => {
                const px = x(event.localDate);
                const laneY = lanes[event.source];
                return event.level === "stop" ? (
                  <Rect key={`p${index}`} x={px - 4} y={laneY - 4} width={8} height={8} rx={1} fill={colors.stop} />
                ) : (
                  <Circle key={`p${index}`} cx={px} cy={laneY} r={4} fill={colors.bg} stroke={colors.warn} strokeWidth={2} />
                );
              })}
          </>
        )}
      </Svg>
    </View>
  );
}

interface SparklineProps {
  readonly series: Series;
}

export function Sparkline({ series }: SparklineProps) {
  const { colors } = useTheme();
  const points = series.points.slice(-12);
  if (points.length < 2) return <Svg width={72} height={24} viewBox="0 0 72 24" />;
  const values = points.map((point) => point.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (series.kind === "bars") {
    return (
      <Svg width={72} height={24} viewBox="0 0 72 24">
        {points.map((point, index) => {
          const barHeight = (point.value / (max || 1)) * 20;
          return <Rect key={index} x={index * 6} y={22 - barHeight} width={4} height={barHeight} rx={1} fill={colors.text2} />;
        })}
      </Svg>
    );
  }
  const invert = series.better === "lower";
  const d = points
    .map((point, index) => {
      const ratio = (point.value - min) / (max - min || 1);
      return `${index === 0 ? "M" : "L"}${(index / (points.length - 1)) * 70 + 1},${invert ? 3 + ratio * 18 : 21 - ratio * 18}`;
    })
    .join("");
  return (
    <Svg width={72} height={24} viewBox="0 0 72 24">
      <Path d={d} fill="none" stroke={colors.text2} strokeWidth={1.75} strokeLinejoin="round" />
    </Svg>
  );
}
