import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { PanResponder, StyleSheet, View } from "react-native";
import type { GestureResponderEvent, HostInstance, LayoutChangeEvent } from "react-native";
import Svg, { Line, Path, Rect } from "react-native-svg";
import { chartSeries, locateTime, reprocessRecording, valueAt } from "@obnixe/core";
import type { ProcessedTrack, TrackTrim } from "@obnixe/core";
import { db } from "@/data/database";
import { areaPath, linePath, paddedRange, project, unproject } from "@/features/recordings/chartGeometry";
import type { PlotScale } from "@/features/recordings/chartGeometry";
import { distanceText, elapsedText } from "@/features/recordings/format";
import type { RecordedActivity } from "@/features/recordings/useRecordedActivity";
import { PrimaryButton } from "@/ui/Button";
import { Sheet } from "@/ui/Overlays";
import { StatRow } from "@/ui/Stats";
import { Text } from "@/ui/Text";
import { useTheme } from "@/ui/theme";
import { radii, wash } from "@/ui/tokens";

const plotHeight = 120;
const handleWidth = 22;
const minimumMs = 60_000;

interface TrimSheetProps {
  readonly open: boolean;
  readonly activity: RecordedActivity;
  readonly onClose: () => void;
  readonly onSave: (trim: TrackTrim) => void;
}

/** `SUM-004`: the start and the end moved on the profile of the whole recording; the file stays as recorded. */
export function TrimSheet({ open, activity, onClose, onSave }: TrimSheetProps) {
  return (
    <Sheet open={open} title="Rogner l'activité" context="Fais glisser le début et la fin sur le profil" onClose={onClose}>
      {open ? <TrimEditor activity={activity} onSave={onSave} /> : null}
    </Sheet>
  );
}

interface Span {
  readonly startMs: number;
  readonly endMs: number;
}

interface TrimEditorProps {
  readonly activity: RecordedActivity;
  readonly onSave: (trim: TrackTrim) => void;
}

interface Stretch {
  readonly distanceMm: number;
  readonly elapsedMs: number;
}

function stretch(whole: ProcessedTrack, span: Span): Stretch {
  const { t, distance } = whole.series;
  const meters = valueAt(distance, locateTime(t, span.endMs)) - valueAt(distance, locateTime(t, span.startMs));
  return { distanceMm: Math.round(meters * 1000), elapsedMs: span.endMs - span.startMs };
}

function TrimEditor({ activity, onSave }: TrimEditorProps) {
  const { colors } = useTheme();
  const { saved, track, profile } = activity;
  const whole = useMemo(() => reprocessRecording(db(), saved, track, { startMs: 0, endMs: null }, profile), [saved, track, profile]);
  const full: Span = whole.elapsed;
  const [span, setSpan] = useState<Span>(() => ({ startMs: Math.max(full.startMs, saved.recording.trimStartMs), endMs: Math.min(full.endMs, saved.recording.trimEndMs ?? full.endMs) }));
  const [width, setWidth] = useState(0);
  const container = useRef<HostInstance>(null);
  const origin = useRef(0);
  const dragging = useRef<"start" | "end">("start");

  const x = useMemo((): PlotScale => ({ min: full.startMs, max: full.endMs, from: handleWidth / 2, to: Math.max(handleWidth, width - handleWidth / 2) }), [full.startMs, full.endMs, width]);
  const profileLine = useMemo(() => {
    if (width === 0) return null;
    const values = whole.summary.ascentMm === null ? Float64Array.from(whole.series.speed) : Float64Array.from(whole.series.altitude);
    const series = chartSeries(whole.series.t, values, whole.summary.ascentMm === null ? "speed" : "altitude", Math.round(width * 2));
    if (series === null) return null;
    const y: PlotScale = { ...paddedRange(series.range, 20, 0.1), from: plotHeight - 4, to: 6 };
    return { line: linePath(series.line, x, y), area: areaPath(series.line, x, y, plotHeight) };
  }, [whole, width, x]);

  const latest = useRef({ x, span, full });
  useLayoutEffect(() => {
    latest.current = { x, span, full };
  });
  const move = (pageX: number, grant: boolean): void => {
    const state = latest.current;
    const at = Math.min(state.full.endMs, Math.max(state.full.startMs, unproject(state.x, pageX - origin.current)));
    if (grant) dragging.current = Math.abs(at - state.span.startMs) <= Math.abs(at - state.span.endMs) ? "start" : "end";
    const next = dragging.current === "start" ? { startMs: Math.min(at, state.span.endMs - minimumMs), endMs: state.span.endMs } : { startMs: state.span.startMs, endMs: Math.max(at, state.span.startMs + minimumMs) };
    setSpan({ startMs: Math.max(state.full.startMs, next.startMs), endMs: Math.min(state.full.endMs, next.endMs) });
  };
  const responder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderGrant: (event: GestureResponderEvent) => move(event.nativeEvent.pageX, true),
        onPanResponderMove: (event: GestureResponderEvent) => move(event.nativeEvent.pageX, false),
        onPanResponderTerminationRequest: () => false,
      }),
    [],
  );

  const onLayout = (event: LayoutChangeEvent): void => {
    setWidth(Math.round(event.nativeEvent.layout.width));
    container.current?.measureInWindow((left: number) => {
      origin.current = left;
    });
  };

  const left = project(x, span.startMs);
  const right = project(x, span.endMs);
  const kept = stretch(whole, span);
  const removedStart = stretch(whole, { startMs: full.startMs, endMs: span.startMs });
  const removedEnd = stretch(whole, { startMs: span.endMs, endMs: full.endMs });
  const distance = distanceText(kept.distanceMm);
  const startTrimmed = span.startMs > full.startMs + 500;
  const endTrimmed = span.endMs < full.endMs - 500;
  const save = (): void => onSave({ startMs: startTrimmed ? Math.round(span.startMs) : 0, endMs: endTrimmed ? Math.round(span.endMs) : null });

  return (
    <View style={styles.root}>
      <View
        ref={container}
        onLayout={onLayout}
        style={[styles.plot, { backgroundColor: colors.surface, borderColor: colors.line }]}
        accessibilityLabel="Profil de l'activité : fais glisser pour rogner"
        {...responder.panHandlers}
      >
        <Svg width={width} height={plotHeight}>
          {profileLine === null ? null : (
            <>
              <Path d={profileLine.area} fill={wash(colors.sport[saved.session.sport], 0.2)} />
              <Path d={profileLine.line} fill="none" stroke={colors.sport[saved.session.sport]} strokeWidth={1.75} />
            </>
          )}
          <Rect x={0} y={0} width={Math.max(0, left)} height={plotHeight} fill={colors.scrim} />
          <Rect x={right} y={0} width={Math.max(0, width - right)} height={plotHeight} fill={colors.scrim} />
          <Line x1={left} x2={left} y1={0} y2={plotHeight} stroke={colors.mark} strokeWidth={3} />
          <Line x1={right} x2={right} y1={0} y2={plotHeight} stroke={colors.mark} strokeWidth={3} />
          <Rect x={left - handleWidth / 2} y={plotHeight / 2 - 18} width={handleWidth} height={36} rx={7} fill={colors.mark} />
          <Rect x={right - handleWidth / 2} y={plotHeight / 2 - 18} width={handleWidth} height={36} rx={7} fill={colors.mark} />
        </Svg>
      </View>
      <View style={styles.removed}>
        <Text variant="caption" tone="secondary">
          {startTrimmed ? `Début : −${distanceText(removedStart.distanceMm).value} km, −${elapsedText(removedStart.elapsedMs)}` : "Début conservé"}
        </Text>
        <Text variant="caption" tone="secondary">
          {endTrimmed ? `Fin : −${distanceText(removedEnd.distanceMm).value} km, −${elapsedText(removedEnd.elapsedMs)}` : "Fin conservée"}
        </Text>
      </View>
      <StatRow
        stats={[
          { label: "Distance", value: distance.value, unit: distance.unit },
          { label: "Durée", value: elapsedText(kept.elapsedMs), unit: "" },
        ]}
      />
      <Text variant="small" tone="secondary">
        Distance, temps, splits, records et cumul du matériel sont recalculés. Le fichier de la trace n'est pas modifié.
      </Text>
      <PrimaryButton label="Rogner" onPress={save} />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { gap: 14, paddingTop: 12 },
  plot: { height: plotHeight, borderRadius: radii.panel, borderWidth: 1, overflow: "hidden" },
  removed: { flexDirection: "row", justifyContent: "space-between" },
});
