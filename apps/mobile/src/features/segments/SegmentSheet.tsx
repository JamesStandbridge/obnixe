import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { PanResponder, StyleSheet, View } from "react-native";
import type { GestureResponderEvent, HostInstance, LayoutChangeEvent } from "react-native";
import Svg, { Line, Path, Rect } from "react-native-svg";
import { chartSeries, locate, measureRange, segmentFamilyOf, segmentRules, valueAt } from "@obnixe/core";
import type { SegmentDraft } from "@obnixe/core";
import { areaPath, linePath, paddedRange, project, unproject } from "@/features/recordings/chartGeometry";
import type { PlotScale } from "@/features/recordings/chartGeometry";
import { distanceText, elapsedText } from "@/features/recordings/format";
import type { RecordedActivity } from "@/features/recordings/useRecordedActivity";
import { formatInteger } from "@/format/numbers";
import { PrimaryButton } from "@/ui/Button";
import { TextField } from "@/ui/Inputs";
import { Sheet } from "@/ui/Overlays";
import { StatRow } from "@/ui/Stats";
import type { StatValue } from "@/ui/Stats";
import { Text } from "@/ui/Text";
import { useTheme } from "@/ui/theme";
import { radii, wash } from "@/ui/tokens";

const plotHeight = 120;
const handleWidth = 22;

/** Whether the activity's sport has segments and the activity is long enough to draw one from. */
export function canDrawSegment(activity: RecordedActivity): boolean {
  return segmentFamilyOf(activity.saved.session.sport) !== null && (activity.processed.series.distance.at(-1) ?? 0) >= segmentRules.minMeters;
}

interface SegmentSheetProps {
  readonly open: boolean;
  readonly activity: RecordedActivity;
  readonly onClose: () => void;
  readonly onSave: (draft: SegmentDraft) => void;
}

/** `SEG-001`: a stretch of the activity chosen on its distance profile, saved under a name. */
export function SegmentSheet({ open, activity, onClose, onSave }: SegmentSheetProps) {
  return (
    <Sheet open={open} title="Créer un segment" context="Fais glisser le début et la fin sur le profil" onClose={onClose}>
      {open ? <SegmentEditor activity={activity} onSave={onSave} /> : null}
    </Sheet>
  );
}

/** Meters along the activity's counted distance. */
interface Span {
  readonly from: number;
  readonly to: number;
}

interface SegmentEditorProps {
  readonly activity: RecordedActivity;
  readonly onSave: (draft: SegmentDraft) => void;
}

function SegmentEditor({ activity, onSave }: SegmentEditorProps) {
  const { colors } = useTheme();
  const { series, summary } = activity.processed;
  const { session } = activity.saved;
  const hasElevation = summary.ascentMm !== null;
  const total = series.distance.at(-1) ?? 0;
  const [span, setSpan] = useState<Span>(() => ({ from: total * 0.25, to: Math.max(total * 0.75, Math.min(total, total * 0.25 + segmentRules.minMeters)) }));
  const [name, setName] = useState("");
  const [width, setWidth] = useState(0);
  const container = useRef<HostInstance>(null);
  const origin = useRef(0);
  const dragging = useRef<"from" | "to">("from");

  const x = useMemo((): PlotScale => ({ min: 0, max: total, from: handleWidth / 2, to: Math.max(handleWidth, width - handleWidth / 2) }), [total, width]);
  const profileLine = useMemo(() => {
    if (width === 0) return null;
    const values = hasElevation ? Float64Array.from(series.altitude) : Float64Array.from(series.speed);
    const line = chartSeries(series.distance, values, hasElevation ? "altitude" : "speed", Math.round(width * 2));
    if (line === null) return null;
    const y: PlotScale = { ...paddedRange(line.range, 20, 0.1), from: plotHeight - 4, to: 6 };
    return { line: linePath(line.line, x, y), area: areaPath(line.line, x, y, plotHeight) };
  }, [series, hasElevation, width, x]);

  const latest = useRef({ x, span, total });
  useLayoutEffect(() => {
    latest.current = { x, span, total };
  });
  const move = (pageX: number, grant: boolean): void => {
    const state = latest.current;
    const minimum = segmentRules.minMeters;
    const at = Math.min(state.total, Math.max(0, unproject(state.x, pageX - origin.current)));
    if (grant) dragging.current = Math.abs(at - state.span.from) <= Math.abs(at - state.span.to) ? "from" : "to";
    const next = dragging.current === "from" ? { from: Math.min(at, state.span.to - minimum), to: state.span.to } : { from: state.span.from, to: Math.max(at, state.span.from + minimum) };
    setSpan({ from: Math.max(0, next.from), to: Math.min(state.total, next.to) });
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

  const range = { from: locate(series.distance, span.from), to: locate(series.distance, span.to) };
  const measure = measureRange(series, hasElevation, range);
  const distance = distanceText(measure.distanceMm);
  const stats: StatValue[] = [
    { label: "Distance", value: distance.value, unit: distance.unit },
    { label: "Ce passage", value: elapsedText(valueAt(series.t, range.to) - valueAt(series.t, range.from)), unit: "" },
  ];
  if (hasElevation) stats.push({ label: "D+", value: formatInteger(measure.ascentMm / 1000), unit: "m" });
  const valid = name.trim() !== "" && measure.distanceMm >= segmentRules.minMeters * 1000;
  const left = project(x, span.from);
  const right = project(x, span.to);

  return (
    <View style={styles.root}>
      <View
        ref={container}
        onLayout={onLayout}
        style={[styles.plot, { backgroundColor: colors.surface, borderColor: colors.line }]}
        accessibilityLabel="Profil de l'activité : fais glisser le début et la fin du segment"
        {...responder.panHandlers}
      >
        <Svg width={width} height={plotHeight}>
          {profileLine === null ? null : (
            <>
              <Path d={profileLine.area} fill={wash(colors.sport[session.sport], 0.2)} />
              <Path d={profileLine.line} fill="none" stroke={colors.sport[session.sport]} strokeWidth={1.75} />
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
      <View style={styles.bounds}>
        <Text variant="caption" tone="secondary">{`Début à ${distanceText(span.from * 1000).value} km`}</Text>
        <Text variant="caption" tone="secondary">{`Fin à ${distanceText(span.to * 1000).value} km`}</Text>
      </View>
      <StatRow stats={stats} />
      <TextField value={name} onChangeText={setName} placeholder="Nom du segment : montée, quai, col…" accessibilityLabel="Nom du segment" maxLength={60} />
      <Text variant="small" tone="secondary">
        Tes passages sur ce segment sont recherchés dans toutes tes activités, dans le même sens, puis classés.
      </Text>
      <PrimaryButton label="Créer le segment" disabled={!valid} onPress={() => onSave({ name, sport: session.sport, sessionId: session.id, range })} />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { gap: 14, paddingTop: 12 },
  plot: { height: plotHeight, borderRadius: radii.panel, borderWidth: 1, overflow: "hidden" },
  bounds: { flexDirection: "row", justifyContent: "space-between" },
});
