import { useMemo, useState } from "react";
import { StyleSheet, useWindowDimensions, View } from "react-native";
import type { LayoutChangeEvent } from "react-native";
import Animated from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { router } from "expo-router";
import { isShortActivity } from "@obnixe/core";
import type { FinishReason, GearWearAlert, ResolvedProfile, ZoneProposal } from "@obnixe/core";
import type { SportKey } from "@obnixe/schema";
import { BottomPanel, FigureRow, Figure, bottomPanelHeight } from "@/features/activity/components";
import { gearWearText } from "@/features/activity/gearWear";
import { AttributionButton } from "@/features/maps/MapControls";
import { MapSurface } from "@/features/maps/MapSurface";
import type { MapOverlay } from "@/features/maps/surface";
import { pointLayers, pointsSourceId, trackLayers, trackSourceId } from "@/features/maps/trackLayers";
import { useMapBase } from "@/features/maps/useMapBase";
import { fitCamera } from "@/features/maps/viewport";
import type { ViewSize } from "@/features/maps/viewport";
import { formatDistance, summaryFigures } from "@/features/recording/metrics";
import { recordingTitle } from "@/features/recording/queries";
import type { RecordLine } from "@/features/recording/records";
import { boundsOf, summaryTrack } from "@/features/recording/summaryTrack";
import type { SummaryTrack } from "@/features/recording/summaryTrack";
import { targetLabel, targetProgress } from "@/features/recording/target";
import type { SlotTarget } from "@/features/recording/target";
import type { RecordingView } from "@/features/tracking/recorderHost";
import { deviceTimeZone, formatTimeAt, weekdayTitle } from "@/format/dates";
import { formatLongClock } from "@/format/durations";
import { plural } from "@/format/labels";
import { formatNumber } from "@/format/numbers";
import { ControlButton, LinkButton, PrimaryButton } from "@/ui/Button";
import { Icon } from "@/ui/icons/Icon";
import { PadSheet } from "@/ui/PadSheet";
import { Confetti } from "@/ui/illustrations/Confetti";
import { CheerScene } from "@/ui/illustrations/scenes";
import { Screen, Section } from "@/ui/Layout";
import { reveal } from "@/ui/motion";
import { BevelView } from "@/ui/Shapes";
import { StatRow } from "@/ui/Stats";
import { Text } from "@/ui/Text";
import { useTheme } from "@/ui/theme";
import { bevels, radii } from "@/ui/tokens";

const mapPadding = 28;
const mapMaxZoom = 16;

const finishEyebrows: Readonly<Record<FinishReason, string>> = {
  user: "Sortie terminée",
  storage_full: "Arrêtée : stockage plein",
  inactivity: "Arrêtée après une longue pause",
  interruption: "Sortie interrompue",
};

interface SummaryMapProps {
  readonly track: SummaryTrack;
  readonly bounds: readonly [number, number, number, number];
  readonly sport: SportKey;
}

function SummaryMap({ track, bounds, sport }: SummaryMapProps) {
  const { colors } = useTheme();
  const [size, setSize] = useState<ViewSize | null>(null);
  const measure = (event: LayoutChangeEvent): void => {
    const { width, height } = event.nativeEvent.layout;
    setSize((current) => (current?.width === width && current.height === height ? current : { width, height }));
  };
  return (
    <View style={[styles.map, { borderColor: colors.line, backgroundColor: colors.surface }]} onLayout={measure} accessibilityLabel="Carte de la sortie">
      {size === null ? null : <StillMap key={`${size.width}x${size.height}`} track={track} bounds={bounds} sport={sport} size={size} />}
    </View>
  );
}

interface StillMapProps extends SummaryMapProps {
  readonly size: ViewSize;
}

function StillMap({ track, bounds, sport, size }: StillMapProps) {
  const { colors, name } = useTheme();
  const base = useMapBase(sport);
  const [initialCamera] = useState(() => fitCamera(bounds, size, mapPadding, mapMaxZoom));
  const overlays = useMemo<MapOverlay[]>(() => {
    const trackColors = { from: colors.sportDeep[sport], to: colors.sport[sport] };
    return [
      { id: trackSourceId, data: track.track, lineMetrics: true, layers: trackLayers(trackColors, name) },
      { id: pointsSourceId, data: track.points, lineMetrics: false, layers: pointLayers(trackColors, name) },
    ];
  }, [track, colors, sport, name]);
  return (
    <>
      <MapSurface mapStyle={base.style} fallbackStyle={base.fallback} initialCamera={initialCamera} overlays={overlays} interactive={false} />
      <View style={styles.attribution}>
        <AttributionButton attribution={base.attribution} />
      </View>
    </>
  );
}

interface StopwatchDistanceProps {
  readonly distanceMm: number;
  readonly meters: boolean;
  readonly disabled: boolean;
  readonly onDistance: (distanceMm: number) => void;
}

const stopwatchDistanceMaxMm = 1_000_000_000;

/** `REC-060`: the distance of a stopwatch recording, typed at the stop and optional. */
function StopwatchDistance({ distanceMm, meters, disabled, onDistance }: StopwatchDistanceProps) {
  const { colors } = useTheme();
  const [open, setOpen] = useState(false);
  const unit = meters ? "m" : "km";
  const typed = distanceMm > 0;
  const current = typed ? formatNumber(meters ? distanceMm / 1000 : distanceMm / 1_000_000, meters ? 0 : 2) : null;
  return (
    <BevelView fill={colors.surface} cut={bevels.card} style={styles.stopwatch}>
      <Text variant="label">Distance</Text>
      <Text variant="small" tone="secondary">
        {typed ? `${current ?? ""} ${unit}, saisie à la main` : "Sans localisation, la distance n'est pas mesurée. Tu peux la saisir si tu la connais."}
      </Text>
      <ControlButton label={typed ? "Modifier la distance" : "Saisir la distance"} disabled={disabled} onPress={() => setOpen(true)} style={styles.stopwatchButton} />
      <PadSheet
        open={open}
        title="Distance"
        context="Saisie à la main"
        mode="number"
        unit={unit}
        decimals={meters ? 0 : 2}
        current={current}
        validate={(value) => (value <= 0 ? "Distance nulle" : value * (meters ? 1000 : 1_000_000) > stopwatchDistanceMaxMm ? `Maximum ${meters ? "1 000 000 m" : "1 000 km"}` : null)}
        {...(typed
          ? {
              action: {
                label: "Retirer la distance",
                appearance: "link",
                onPress: () => {
                  setOpen(false);
                  onDistance(0);
                },
              },
            }
          : {})}
        onSubmit={(result) => {
          setOpen(false);
          if (result.kind === "value") onDistance(Math.round(result.value * (meters ? 1000 : 1_000_000)));
        }}
        onClose={() => setOpen(false)}
      />
    </BevelView>
  );
}

interface FinishViewProps {
  readonly recording: RecordingView;
  readonly reason: FinishReason;
  readonly target: SlotTarget | null;
  readonly onSave: () => void;
  readonly onResume: () => void;
  readonly onDiscard: () => void;
  readonly onDistance: (distanceMm: number) => void;
}

/** `REC-050`, `REC-052`: the stop summary, before *Enregistrer*, *Reprendre* or *Supprimer*; a stopwatch one takes its distance (`REC-060`). */
export function FinishView({ recording, reason, target, onSave, onResume, onDiscard, onDistance }: FinishViewProps) {
  const { colors } = useTheme();
  const { sessionId, profile, summary, startedAt } = recording;
  const title = useMemo(() => recordingTitle(sessionId) ?? "Sortie", [sessionId]);
  const timeZone = useMemo(() => deviceTimeZone(), []);
  const track = useMemo(() => (summary === null ? null : summaryTrack(summary.processed.series)), [summary]);
  const box = summary?.processed.summary.bbox ?? null;
  const short = summary !== null && isShortActivity({ movingMs: summary.processed.summary.movingMs, distanceMm: profile.stopwatch ? null : summary.processed.summary.distanceMm });
  const busy = recording.busy || summary === null;
  const endAt = startedAt + (summary?.endT ?? recording.clock?.elapsedMs ?? 0);
  const figures = summary === null ? null : summaryFigures(summary.processed.summary, profile);
  const progress = target === null || summary === null ? null : targetProgress(target, summary.processed.summary);

  return (
    <View style={[styles.root, { backgroundColor: colors.bg }]}>
      <Screen bottomInset={bottomPanelHeight + 96}>
        <Animated.View entering={reveal(0)} style={styles.head}>
          <Text variant="eyebrow" style={{ color: reason === "user" ? colors.mark : colors.warn }}>
            {finishEyebrows[reason]}
          </Text>
          <Text variant="title" accessibilityRole="header">
            {title}
          </Text>
          <Text variant="small" tone="secondary">
            {`${weekdayTitle(startedAt, timeZone)} · ${formatTimeAt(startedAt, timeZone)} – ${formatTimeAt(endAt as typeof startedAt, timeZone)}`}
          </Text>
        </Animated.View>

        {profile.stopwatch ? (
          <StopwatchDistance distanceMm={summary?.distanceMm ?? 0} meters={profile.pacePerMeters === 100} disabled={busy} onDistance={onDistance} />
        ) : track !== null && box !== null ? (
          <SummaryMap track={track} bounds={boundsOf(box)} sport={profile.sport} />
        ) : (
          <View style={[styles.map, styles.noMap, { borderColor: colors.line, backgroundColor: colors.surface }]}>
            <Text variant="small" tone="secondary">
              {summary === null ? "Calcul du résumé…" : "Aucune position enregistrée"}
            </Text>
          </View>
        )}

        {short ? (
          <View style={[styles.short, { backgroundColor: colors.surface, borderLeftColor: colors.warn }]} accessibilityLiveRegion="polite">
            <Text variant="label">Activité très courte</Text>
            <Text variant="caption" tone="secondary">
              {profile.stopwatch ? "Moins de 30 secondes d'activité : tu peux la supprimer." : "Moins de 30 secondes en mouvement ou de 50 mètres : tu peux la supprimer."}
            </Text>
          </View>
        ) : null}

        {figures === null ? null : (
          <Animated.View entering={reveal(1)} style={styles.figures}>
            <FigureRow
              left={
                figures.distance === null ? null : (
                  <Figure value={figures.distance.value} label={`Distance · ${figures.distance.unit}`} size={72} accessibilityLabel={`Distance, ${figures.distance.value} ${figures.distance.unit}`} />
                )
              }
              right={<Figure value={figures.moving} label="En mouvement" size={72} accessibilityLabel={`Temps en mouvement, ${figures.moving}`} />}
            />
            <StatRow stats={figures.stats.slice(0, 3)} />
            {figures.stats.length > 3 ? <StatRow stats={figures.stats.slice(3)} /> : null}
          </Animated.View>
        )}

        {progress === null || target === null ? null : (
          <Text variant="label" style={[styles.target, { color: progress.reached ? colors.mark : colors.text2 }]}>
            {progress.reached ? `Objectif ${targetLabel(target)} atteint` : `Objectif ${targetLabel(target)} : ${progress.done} réalisés`}
          </Text>
        )}
        {recording.laps.length === 0 ? null : (
          <Text variant="small" tone="secondary" style={styles.laps}>
            {plural(recording.laps.length + 1, "tour")}
          </Text>
        )}
      </Screen>

      <BottomPanel>
        <View style={styles.actions}>
          {short ? (
            <PrimaryButton label="Supprimer" disabled={busy} icon={<Icon name="close" size={20} color={busy ? colors.text2 : colors.actInk} />} onPress={onDiscard} />
          ) : (
            <PrimaryButton label="Enregistrer" disabled={busy} icon={<Icon name="check" size={20} color={busy ? colors.text2 : colors.actInk} />} onPress={onSave} />
          )}
          <View style={styles.secondary}>
            <ControlButton label="Reprendre" icon={<Icon name="play" size={16} color={colors.text} />} disabled={recording.busy} onPress={onResume} style={styles.resume} />
            {short ? <LinkButton label="Enregistrer quand même" disabled={busy} onPress={onSave} /> : <LinkButton label="Supprimer" disabled={busy} onPress={onDiscard} />}
          </View>
        </View>
      </BottomPanel>
    </View>
  );
}

interface RecoveryViewProps {
  readonly recording: RecordingView;
  readonly endT: number;
  readonly onResume: () => void;
  readonly onFinish: () => void;
}

/** `REC-081`: a recording interrupted by the system, found again at launch. */
export function RecoveryView({ recording, endT, onResume, onFinish }: RecoveryViewProps) {
  const { colors } = useTheme();
  const { sessionId, profile, startedAt, live } = recording;
  const title = useMemo(() => recordingTitle(sessionId) ?? "Sortie", [sessionId]);
  const timeZone = useMemo(() => deviceTimeZone(), []);
  const distance = profile.stopwatch ? null : formatDistance(live.distanceMm / 1000);
  return (
    <View style={[styles.root, { backgroundColor: colors.bg }]}>
      <Screen bottomInset={bottomPanelHeight + 96}>
        <BevelView fill={colors.sport[profile.sport]} cut={bevels.card} style={styles.recoveryHero}>
          <CheerScene sport={profile.sport} size={150} />
        </BevelView>
        <View style={styles.head}>
          <Text variant="eyebrow" style={{ color: colors.warn }}>
            Sortie interrompue
          </Text>
          <Text variant="title" accessibilityRole="header">
            {title}
          </Text>
          <Text variant="body" tone="secondary">
            {`L'enregistrement s'est arrêté à ${formatTimeAt((startedAt + endT) as typeof startedAt, timeZone)}, quand le téléphone l'a fermé. Ce qui a été mesuré jusque-là est conservé.`}
          </Text>
        </View>
        <View style={styles.figures}>
          <FigureRow
            left={distance === null ? null : <Figure value={distance.value} label={`Distance · ${distance.unit}`} size={64} accessibilityLabel={`Distance, ${distance.value} ${distance.unit}`} />}
            right={<Figure value={formatLongClock(live.movingMs / 1000)} label="En mouvement" size={64} accessibilityLabel={`Temps en mouvement, ${formatLongClock(live.movingMs / 1000)}`} />}
          />
        </View>
        <Text variant="small" tone="secondary" style={styles.recoveryNote}>
          En reprenant, le temps passé depuis l'arrêt compte comme une pause.
        </Text>
        <LinkButton label="Éviter que le téléphone ne la coupe" onPress={() => router.push("/settings/battery")} style={styles.recoveryHelp} />
      </Screen>
      <BottomPanel>
        <View style={styles.actions}>
          <PrimaryButton label="Reprendre la sortie" disabled={recording.busy} icon={<Icon name="play" size={20} color={recording.busy ? colors.text2 : colors.actInk} />} onPress={onResume} />
          <ControlButton label="Terminer et voir le résumé" disabled={recording.busy} onPress={onFinish} />
        </View>
      </BottomPanel>
    </View>
  );
}

interface SavedViewProps {
  readonly sport: SportKey;
  readonly lines: readonly RecordLine[];
  readonly proposal: ZoneProposal | null;
  readonly wear: GearWearAlert | null;
  readonly onRetireGear: () => void;
  readonly onCreateZone: () => void;
  readonly onDeclineZone: () => void;
  readonly onContinue: () => void;
}

/** `PR-004` records of the saved activity, the `PRV-014` zone offer and the `INT-011` gear wear. */
export function SavedView({ sport, lines, proposal, wear, onRetireGear, onCreateZone, onDeclineZone, onContinue }: SavedViewProps) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const celebrated = lines.some((line) => line.record);
  return (
    <View style={[styles.root, { backgroundColor: colors.bg }]}>
      <Screen bottomInset={bottomPanelHeight + 40}>
        <Animated.View entering={reveal(0)} style={styles.head}>
          <Text variant="eyebrow" style={{ color: colors.mark }}>
            Sortie enregistrée
          </Text>
          <Text variant="title" accessibilityRole="header">
            {celebrated ? "Nouveau record" : lines.length > 0 ? "Belle sortie" : "C'est noté"}
          </Text>
        </Animated.View>

        {lines.length === 0 ? null : (
          <Section title="Records">
            {lines.map((line, index) => (
              <Animated.View key={line.key} entering={reveal(index + 1)} style={[styles.record, { borderBottomColor: colors.line }]}>
                <View style={[styles.medal, { backgroundColor: line.record ? colors.actBg : colors.surface2 }]}>
                  <Icon name={line.record ? "check" : "flag"} size={16} color={line.record ? colors.actInk : colors.text} />
                </View>
                <View style={styles.recordText}>
                  <Text variant="bodyStrong">{line.title}</Text>
                  <Text variant="small" tone="secondary">
                    {line.detail}
                  </Text>
                </View>
              </Animated.View>
            ))}
          </Section>
        )}

        {proposal === null ? null : (
          <Section title="Lieu fréquent">
            <BevelView fill={colors.surface} cut={bevels.card} style={styles.zone}>
              <Text variant="bodyStrong">Masquer ce lieu sur tes traces ?</Text>
              <Text variant="small" tone="secondary">
                {`Tu as démarré ou terminé ${plural(proposal.activities, "sortie")} ici. Une zone de confidentialité de ${proposal.radiusMeters} m cache ce lieu sur les traces que tu partages.`}
              </Text>
              <View style={styles.zoneActions}>
                <ControlButton label="Créer la zone" onPress={onCreateZone} />
                <LinkButton label="Non merci" onPress={onDeclineZone} />
              </View>
            </BevelView>
          </Section>
        )}

        {wear === null ? null : (
          <Section title="Matériel">
            <BevelView fill={colors.surface} cut={bevels.card} style={styles.zone}>
              <Text variant="bodyStrong">{`Pense à remplacer ${wear.gear.name}`}</Text>
              <Text variant="small" tone="secondary">
                {gearWearText(wear)}
              </Text>
              <View style={styles.zoneActions}>
                <ControlButton label="Retirer ce matériel" onPress={onRetireGear} />
              </View>
            </BevelView>
          </Section>
        )}
      </Screen>
      <BottomPanel>
        <PrimaryButton label="Voir le bilan" icon={<Icon name="forward" size={20} color={colors.actInk} />} onPress={onContinue} />
      </BottomPanel>
      {celebrated ? <Confetti width={width} originY={insets.top + 90} /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  head: { gap: 6, marginTop: 8 },
  map: { marginTop: 18, height: 220, borderRadius: radii.panel, borderWidth: 1, overflow: "hidden" },
  noMap: { alignItems: "center", justifyContent: "center" },
  attribution: { position: "absolute", left: 10, bottom: 10 },
  short: { marginTop: 14, paddingHorizontal: 12, paddingVertical: 10, borderRadius: radii.control, borderLeftWidth: 4, gap: 2 },
  figures: { marginTop: 20, gap: 16 },
  target: { marginTop: 16 },
  laps: { marginTop: 8 },
  stopwatch: { marginTop: 18, padding: 16, gap: 6 },
  stopwatchButton: { alignSelf: "flex-start", marginTop: 6 },
  actions: { gap: 8 },
  secondary: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 },
  resume: { minWidth: 140 },
  recoveryHero: { height: 170, alignItems: "center", justifyContent: "center", marginTop: 8 },
  recoveryNote: { marginTop: 18 },
  recoveryHelp: { alignSelf: "flex-start", marginTop: 8 },
  record: { flexDirection: "row", alignItems: "center", gap: 12, minHeight: 60, paddingVertical: 10, borderBottomWidth: 1 },
  medal: { width: 32, height: 32, borderRadius: 16, alignItems: "center", justifyContent: "center" },
  recordText: { flex: 1, gap: 2 },
  zone: { padding: 16, gap: 8 },
  zoneActions: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 4 },
});
