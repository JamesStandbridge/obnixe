import { useEffect, useMemo, useRef, useState } from "react";
import { BackHandler, Pressable, ScrollView, StyleSheet, useWindowDimensions, View } from "react-native";
import type { NativeScrollEvent, NativeSyntheticEvent, ScrollViewInstance } from "react-native";
import Animated, { FadeInDown, FadeOutUp, LinearTransition, useAnimatedStyle } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Stack, useRouter } from "expo-router";
import { notificationAsync, NotificationFeedbackType } from "expo-haptics";
import type { LiveLap, RecorderPhase, ResolvedProfile } from "@obnixe/core";
import type { EpochMs, MetricKey } from "@obnixe/schema";
import { updateSettings, useRecordingDisplay } from "@/data/settings";
import { SwitchRow } from "@/features/activity/components";
import { LiveMap } from "@/features/maps/LiveMap";
import { LiveControls } from "@/features/recording/LiveControls";
import { Chronometer, MetricTile, SignalBars } from "@/features/recording/LiveParts";
import { lapFigures, metricCaptions, metricText } from "@/features/recording/metrics";
import type { MetricText } from "@/features/recording/metrics";
import { sessionTargetOf } from "@/features/recording/queries";
import { liveReadout } from "@/features/recording/readout";
import { targetLabel, targetProgress } from "@/features/recording/target";
import { openSystemSettings } from "@/features/tracking/permissions";
import { recorder } from "@/features/tracking/recorder";
import type { RecordingView } from "@/features/tracking/recorderHost";
import { useNow } from "@/features/training/useLiveLoad";
import { deviceTimeZone } from "@/format/dates";
import { formatLongClock } from "@/format/durations";
import { Icon } from "@/ui/icons/Icon";
import { IconButton, MenuItem } from "@/ui/Inputs";
import { useLoop } from "@/ui/motion";
import { Sheet } from "@/ui/Overlays";
import { useSnackbar } from "@/ui/SnackbarHost";
import { Text } from "@/ui/Text";
import { useTheme } from "@/ui/theme";
import { fonts, layout, radii } from "@/ui/tokens";
import { useKeepAwakeWhile } from "@/ui/useKeepAwakeWhile";
import type { TrackerIssueKind } from "../../../modules/obnixe-tracker";

type Page = "metrics" | "laps" | "map";

const pages: readonly { readonly key: Page; readonly label: string }[] = [
  { key: "metrics", label: "Données" },
  { key: "laps", label: "Tours" },
  { key: "map", label: "Carte" },
];

const lapBannerMs = 5000;

interface LiveScreenProps {
  readonly recording: RecordingView;
}

/** `UX-001`, `UX-002`: the live pages of a recording, with its controls and lock. */
export function LiveScreen({ recording }: LiveScreenProps) {
  const { colors, name: palette } = useTheme();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const router = useRouter();
  const notify = useSnackbar();
  const display = useRecordingDisplay();
  useKeepAwakeWhile(display.keepScreenOn);
  const pager = useRef<ScrollViewInstance>(null);
  const [page, setPage] = useState<Page>("metrics");
  const [locked, setLocked] = useState(false);
  const [menu, setMenu] = useState(false);
  const [confirmStop, setConfirmStop] = useState(false);
  const [controlsHeight, setControlsHeight] = useState(120);

  const { sessionId, profile, state, live, laps, clock } = recording;
  const phase = state.phase;
  const readout = useMemo(() => liveReadout(profile, recording.settings), [profile, recording.settings]);
  const target = useMemo(() => sessionTargetOf(sessionId), [sessionId]);
  const timeZone = useMemo(() => deviceTimeZone(), []);
  const now = useNow(readout.main === "clock" || readout.secondary.includes("clock") ? 15_000 : 3_600_000);
  const text = (key: MetricKey): MetricText => metricText(key, live.metrics, profile, now as EpochMs, timeZone);
  const lapBanner = useLapBanner(laps);
  const progress = target === null ? null : targetProgress(target, live);

  const reached = progress?.reached === true;
  const announced = useRef(reached);
  useEffect(() => {
    if (reached && !announced.current) void notificationAsync(NotificationFeedbackType.Success);
    announced.current = reached;
  }, [reached]);

  useEffect(() => {
    if (!locked) return undefined;
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => true);
    return () => subscription.remove();
  }, [locked]);

  const goTo = (next: Page): void => {
    setPage(next);
    pager.current?.scrollTo({ x: pages.findIndex((item) => item.key === next) * width, animated: true });
  };

  const settle = (event: NativeSyntheticEvent<NativeScrollEvent>): void => {
    const index = Math.round(event.nativeEvent.contentOffset.x / width);
    const next = pages[index]?.key;
    if (next !== undefined) setPage(next);
  };

  const failed = (outcome: { readonly ok: boolean }): void => {
    if (!outcome.ok) notify({ text: "Action impossible pour le moment", aboveTabBar: false, extraOffset: 96 });
  };

  const stop = (): void => {
    setConfirmStop(false);
    void recorder.stop().then(failed);
  };

  const feed = recorder.mapFeed();
  const pausedFor = phase === "paused" && clock !== null ? Math.max(0, clock.elapsedMs - state.since) : null;

  return (
    <View style={[styles.root, { backgroundColor: colors.bg }]}>
      <Stack.Screen options={{ gestureEnabled: !locked }} />
      <View style={[styles.header, { paddingTop: insets.top + 6 }]}>
        <View style={styles.headerRow}>
          <StateChip phase={phase} sport={colors.sport[profile.sport]} />
          <View style={styles.timer} accessible accessibilityLabel={`Chronomètre ${formatLongClock((clock?.timerMs ?? 0) / 1000)}`}>
            <Chronometer baseAt={recording.timerBaseAt} frozenMs={recording.timerBaseAt === null ? (clock?.timerMs ?? 0) : 0} />
          </View>
          <SignalBars level={live.signal.level} />
          <IconButton icon="sun" label="Mode plein soleil" pressed={palette === "sunlight"} onPress={() => updateSettings({ theme: palette === "sunlight" ? "dark" : "sunlight" })} />
          <IconButton icon="lock" label="Verrouiller l'écran" onPress={() => setLocked(true)} />
          <IconButton icon="more" label="Options de la sortie" edge="end" onPress={() => setMenu(true)} />
        </View>
        <View style={styles.tabs} accessibilityRole="tablist">
          {pages.map((item) => {
            const selected = item.key === page;
            return (
              <Pressable
                key={item.key}
                accessibilityRole="tab"
                accessibilityState={{ selected }}
                onPress={() => goTo(item.key)}
                style={[styles.tab, { borderBottomColor: selected ? colors.mark : "transparent" }]}
              >
                <Text variant="label" tone={selected ? "primary" : "secondary"}>
                  {item.label}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </View>

      <View style={styles.banners}>
        {phase === "auto_paused" ? <Banner key="auto" tone="warn" title="Pause automatique" detail="Reprend dès que tu bouges" /> : null}
        {pausedFor === null ? null : <Banner key="paused" tone="warn" title="En pause" detail={`Depuis ${formatLongClock(pausedFor / 1000)}`} />}
        {recording.issues.map((issue) => (
          <IssueBanner key={issue} issue={issue} />
        ))}
        {recording.saverOffered ? (
          <Banner
            key="saver"
            tone="warn"
            title="Batterie faible"
            detail="Le mode économie espace les points GPS"
            actions={[
              { label: "Économie", run: () => recorder.setPower("saver") },
              { label: "Non", run: () => recorder.dismissSaverOffer() },
            ]}
          />
        ) : null}
        {lapBanner === null ? null : <LapBanner key={`lap-${lapBanner.index}`} lap={lapBanner} profile={profile} />}
      </View>

      <ScrollView
        ref={pager}
        horizontal
        pagingEnabled
        scrollEnabled={!locked}
        showsHorizontalScrollIndicator={false}
        onMomentumScrollEnd={settle}
        style={styles.pager}
      >
        <View style={[styles.page, { width }]}>
          {progress === null || target === null ? null : (
            <View style={styles.target} accessible accessibilityLabel={progress.reached ? `Objectif ${targetLabel(target)} atteint` : `Objectif ${targetLabel(target)}, ${Math.round(progress.fraction * 100)} %`}>
              <View style={styles.targetHead}>
                <Text variant="eyebrow" tone="secondary">
                  Objectif {targetLabel(target)}
                </Text>
                <Text variant="caption" style={{ color: progress.reached ? colors.mark : colors.text2 }}>
                  {progress.reached ? "Atteint" : `${progress.done} / ${progress.goal}`}
                </Text>
              </View>
              <View style={[styles.targetTrack, { backgroundColor: colors.surface2 }]}>
                <View style={[styles.targetFill, { width: `${Math.round(progress.fraction * 100)}%`, backgroundColor: progress.reached ? colors.mark : colors.sport[profile.sport] }]} />
              </View>
            </View>
          )}
          <View style={[styles.mainTile, { borderBottomColor: colors.line }, phase === "paused" && styles.dimmed]}>
            <MetricTile caption={metricCaptions[readout.main]} text={text(readout.main)} size={112} minimumScale={0.6} accent={colors.sport[profile.sport]} />
          </View>
          <View style={[styles.grid, phase === "paused" && styles.dimmed]}>
            {readout.secondary.map((key, index) => (
              <MetricTile
                key={key}
                caption={metricCaptions[key]}
                text={text(key)}
                size={48}
                minimumScale={0.7}
                style={[styles.cell, { borderTopColor: colors.line }, index === readout.secondary.length - 1 && readout.secondary.length % 2 === 1 ? styles.cellWide : null]}
              />
            ))}
          </View>
        </View>

        <View style={[styles.page, { width }]}>
          <LapsPage current={live.lap} laps={laps} profile={profile} />
        </View>

        <View style={[styles.page, styles.mapPage, { width }]}>
          {feed === null ? null : <LiveMap feed={feed} sport={profile.sport} visible={page === "map"} />}
          <View style={[styles.mapCard, { backgroundColor: colors.bg, borderColor: colors.line }]} pointerEvents="none">
            {[readout.main, ...readout.secondary.slice(0, 2)].map((key) => (
              <MetricTile key={key} caption={metricCaptions[key]} text={text(key)} size={30} minimumScale={0.8} style={styles.mapTile} />
            ))}
          </View>
        </View>
      </ScrollView>

      <View
        onLayout={(event) => setControlsHeight(event.nativeEvent.layout.height)}
        style={[styles.controls, { paddingBottom: insets.bottom + 12, borderTopColor: colors.line, backgroundColor: colors.bg }]}
      >
        <LiveControls
          phase={phase}
          locked={locked}
          busy={recording.busy}
          onLap={() => {
            failed(recorder.lap());
          }}
          onPause={() => failed(recorder.pause())}
          onResume={() => void recorder.resume().then(failed)}
          onStop={stop}
          onConfirmStop={() => setConfirmStop(true)}
          onUnlock={() => setLocked(false)}
        />
      </View>

      {locked ? <LockShield top={insets.top} bottom={controlsHeight} /> : null}

      <Sheet open={menu} title="Options de la sortie" onClose={() => setMenu(false)}>
        <View>
          <SwitchRow title="Pause automatique" detail="Quand tu t'arrêtes" value={"autoPause" in state && state.autoPause} onChange={(value) => failed(recorder.setAutoPause(value))} />
          <SwitchRow title="Garder l'écran allumé" detail="Pour toutes les sorties" value={display.keepScreenOn} onChange={(value) => updateSettings({ keepScreenOn: value })} />
          <SwitchRow
            title="Mode économie d'énergie"
            detail={recording.power === "critical" ? "Batterie critique : points GPS espacés" : "Points GPS plus espacés"}
            value={recording.power !== "normal"}
            onChange={(value) => recorder.setPower(value ? "saver" : "normal")}
          />
          <MenuItem
            label="Revenir à l'accueil"
            detail="L'enregistrement continue"
            onPress={() => {
              setMenu(false);
              router.navigate("/");
            }}
          />
        </View>
      </Sheet>
      <Sheet open={confirmStop} title="Terminer la sortie ?" context="Tu verras le résumé avant d'enregistrer" onClose={() => setConfirmStop(false)}>
        <View>
          <MenuItem label="Terminer" onPress={stop} />
          <MenuItem label="Continuer la sortie" onPress={() => setConfirmStop(false)} />
        </View>
      </Sheet>
    </View>
  );
}

function useLapBanner(laps: readonly LiveLap[]): LiveLap | null {
  const seen = useRef(laps.length);
  const [shown, setShown] = useState<LiveLap | null>(null);
  useEffect(() => {
    if (laps.length <= seen.current) {
      seen.current = laps.length;
      return undefined;
    }
    seen.current = laps.length;
    const latest = laps[laps.length - 1] ?? null;
    setShown(latest);
    void notificationAsync(NotificationFeedbackType.Success);
    const timer = setTimeout(() => setShown(null), lapBannerMs);
    return () => clearTimeout(timer);
  }, [laps]);
  return shown;
}

const phaseLabels: Readonly<Record<RecorderPhase, string>> = {
  preparing: "Démarrage",
  recording: "En cours",
  auto_paused: "Pause auto",
  paused: "En pause",
  finishing: "Terminée",
  interrupted: "Interrompue",
  saved: "Enregistrée",
  discarded: "Supprimée",
};

interface StateChipProps {
  readonly phase: RecorderPhase;
  readonly sport: string;
}

function StateChip({ phase, sport }: StateChipProps) {
  const { colors } = useTheme();
  const running = phase === "recording";
  const tone = running ? sport : phase === "preparing" ? colors.text3 : colors.warn;
  return (
    <View style={[styles.chip, { backgroundColor: running ? colors.surface : colors.surface2 }]} accessible accessibilityLiveRegion="polite" accessibilityLabel={phaseLabels[phase]}>
      <LiveDot color={tone} pulsing={running} />
      <Text style={[styles.chipLabel, { color: colors.text }]} numberOfLines={1}>
        {phaseLabels[phase]}
      </Text>
    </View>
  );
}

interface LiveDotProps {
  readonly color: string;
  readonly pulsing: boolean;
}

function LiveDot({ color, pulsing }: LiveDotProps) {
  const loop = useLoop(1400);
  const ring = useAnimatedStyle(() => ({ opacity: 0.6 * (1 - loop.value), transform: [{ scale: 1 + loop.value * 1.6 }] }));
  return (
    <View style={styles.dotBox}>
      {pulsing ? <Animated.View style={[styles.dotRing, { backgroundColor: color }, ring]} /> : null}
      <View style={[styles.dot, { backgroundColor: color }]} />
    </View>
  );
}

interface BannerAction {
  readonly label: string;
  readonly run: () => void;
}

interface BannerProps {
  readonly tone: "warn" | "stop" | "mark";
  readonly title: string;
  readonly detail: string;
  readonly actions?: readonly BannerAction[];
}

function Banner({ tone, title, detail, actions = [] }: BannerProps) {
  const { colors } = useTheme();
  const accent = tone === "warn" ? colors.warn : tone === "stop" ? colors.stop : colors.mark;
  return (
    <Animated.View
      entering={FadeInDown.duration(200)}
      exiting={FadeOutUp.duration(160)}
      layout={LinearTransition.duration(180)}
      style={[styles.banner, { backgroundColor: colors.surface, borderLeftColor: accent }]}
      accessibilityLiveRegion="polite"
    >
      <View style={styles.bannerText}>
        <Text variant="label">{title}</Text>
        <Text variant="caption" tone="secondary" numberOfLines={2}>
          {detail}
        </Text>
      </View>
      {actions.map((action) => (
        <Pressable key={action.label} accessibilityRole="button" onPress={action.run} style={({ pressed }) => [styles.bannerAction, pressed && { backgroundColor: colors.surfacePress }]}>
          <Text variant="label" style={{ color: colors.mark }}>
            {action.label}
          </Text>
        </Pressable>
      ))}
    </Animated.View>
  );
}

function IssueBanner({ issue }: { readonly issue: TrackerIssueKind }) {
  switch (issue) {
    case "permission_lost":
      return <Banner tone="stop" title="Position refusée" detail="La trace est suspendue jusqu'à la nouvelle autorisation" actions={[{ label: "Réglages", run: openSystemSettings }]} />;
    case "provider_disabled":
      return <Banner tone="stop" title="Localisation désactivée" detail="Réactive-la pour continuer la trace" actions={[{ label: "Réglages", run: openSystemSettings }]} />;
    case "storage_low":
      return <Banner tone="warn" title="Stockage presque plein" detail="L'enregistrement s'arrêtera s'il n'y a plus de place" />;
    case "storage_full":
      return <Banner tone="stop" title="Stockage plein" detail="L'enregistrement s'arrête" />;
    case "heart_rate_lost":
      return <Banner tone="warn" title="Capteur cardiaque perdu" detail="Reconnexion en cours" />;
    default: {
      const unreachable: never = issue;
      return unreachable;
    }
  }
}

interface LapBannerProps {
  readonly lap: LiveLap;
  readonly profile: ResolvedProfile;
}

function LapBanner({ lap, profile }: LapBannerProps) {
  const figures = lapFigures(lap, profile);
  return <Banner tone="mark" title={figures.title} detail={`${figures.duration} · ${figures.distance.value} ${figures.distance.unit} · ${figures.rate.value} ${figures.rate.unit}`} />;
}

interface LapsPageProps {
  readonly current: LiveLap;
  readonly laps: readonly LiveLap[];
  readonly profile: ResolvedProfile;
}

/** `REC-040`: the current lap first, then the finished ones from the latest. */
function LapsPage({ current, laps, profile }: LapsPageProps) {
  const { colors } = useTheme();
  const live = lapFigures(current, profile);
  return (
    <ScrollView contentContainerStyle={styles.laps}>
      <View style={[styles.currentLap, { backgroundColor: colors.surface, borderLeftColor: colors.sport[profile.sport] }]}>
        <Text variant="eyebrow" tone="secondary">
          {`${live.title} · en cours`}
        </Text>
        <View style={styles.currentFigures}>
          <MetricTile caption="Durée" text={{ value: live.duration, unit: "" }} size={40} minimumScale={0.8} style={styles.lapTile} />
          <MetricTile caption="Distance" text={live.distance} size={40} minimumScale={0.8} style={styles.lapTile} />
          <MetricTile caption={profile.primary === "pace" ? "Allure" : "Vitesse"} text={live.rate} size={40} minimumScale={0.8} style={styles.lapTile} />
        </View>
      </View>
      {laps.length === 0 ? (
        <Text variant="small" tone="secondary" style={styles.lapsEmpty}>
          Touche Tour pour découper ta sortie.
        </Text>
      ) : (
        [...laps].reverse().map((lap) => {
          const figures = lapFigures(lap, profile);
          return (
            <View key={lap.index} style={[styles.lapRow, { borderBottomColor: colors.line }]} accessible accessibilityLabel={`${figures.title}, ${figures.duration}, ${figures.distance.value} ${figures.distance.unit}, ${figures.rate.value} ${figures.rate.unit}`}>
              <Text style={[styles.lapIndex, { color: colors.text2 }]}>{lap.index + 1}</Text>
              <Text style={[styles.lapValue, { color: colors.text }]}>{figures.duration}</Text>
              <Text style={[styles.lapValue, { color: colors.text }]}>
                {figures.distance.value}
                <Text style={[styles.lapUnit, { color: colors.text2 }]}>{` ${figures.distance.unit}`}</Text>
              </Text>
              <Text style={[styles.lapValue, styles.lapRate, { color: colors.text }]}>
                {figures.rate.value}
                <Text style={[styles.lapUnit, { color: colors.text2 }]}>{` ${figures.rate.unit}`}</Text>
              </Text>
            </View>
          );
        })
      )}
    </ScrollView>
  );
}

interface LockShieldProps {
  readonly top: number;
  readonly bottom: number;
}

/** `UX-003`: swallows every touch above the controls until the unlock. */
function LockShield({ top, bottom }: LockShieldProps) {
  const { colors } = useTheme();
  return (
    <View style={[styles.shield, { paddingTop: top + 64, bottom }]} onStartShouldSetResponder={() => true}>
      <View style={[styles.lockBadge, { backgroundColor: colors.surface2 }]} accessible accessibilityLabel="Écran verrouillé">
        <Icon name="lock" size={14} color={colors.text} />
        <Text variant="caption">Verrouillé</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: { paddingHorizontal: layout.gutter },
  headerRow: { flexDirection: "row", alignItems: "center", gap: 6, minHeight: 48 },
  timer: { flex: 1, alignItems: "center" },
  tabs: { flexDirection: "row", gap: 4, marginTop: 2 },
  tab: { flex: 1, minHeight: 40, alignItems: "center", justifyContent: "center", borderBottomWidth: 3 },
  banners: { paddingHorizontal: layout.gutter, gap: 6, paddingTop: 6 },
  banner: { flexDirection: "row", alignItems: "center", gap: 8, paddingLeft: 12, paddingRight: 4, minHeight: 52, borderRadius: radii.control, borderLeftWidth: 4 },
  bannerText: { flex: 1, minWidth: 0, paddingVertical: 8, gap: 1 },
  bannerAction: { minHeight: 44, paddingHorizontal: 10, justifyContent: "center", borderRadius: radii.control },
  pager: { flex: 1 },
  page: { flex: 1, paddingHorizontal: layout.gutter },
  target: { marginTop: 12, gap: 6 },
  targetHead: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  targetTrack: { height: 8, borderRadius: 4, overflow: "hidden" },
  targetFill: { height: 8, borderRadius: 4 },
  mainTile: { paddingTop: 18, paddingBottom: 14, borderBottomWidth: 1 },
  grid: { flexDirection: "row", flexWrap: "wrap", columnGap: 16 },
  cell: { width: "47%", flexGrow: 1, paddingVertical: 12, borderTopWidth: 0, marginTop: 2 },
  cellWide: { width: "100%" },
  dimmed: { opacity: 0.55 },
  mapPage: { paddingHorizontal: 0 },
  mapCard: { position: "absolute", top: 10, left: layout.gutter, right: layout.gutter, flexDirection: "row", gap: 12, paddingHorizontal: 14, paddingVertical: 10, borderRadius: radii.panel, borderWidth: 1 },
  mapTile: { flex: 1 },
  controls: { paddingHorizontal: layout.gutter, paddingTop: 12, borderTopWidth: 1 },
  chip: { flexDirection: "row", alignItems: "center", gap: 7, height: 32, paddingHorizontal: 10, borderRadius: 16 },
  chipLabel: { fontFamily: fonts.text700, fontSize: 13 },
  dotBox: { width: 10, height: 10, alignItems: "center", justifyContent: "center" },
  dot: { width: 10, height: 10, borderRadius: 5 },
  dotRing: { position: "absolute", width: 10, height: 10, borderRadius: 5 },
  laps: { paddingTop: 14, paddingBottom: 24 },
  currentLap: { padding: 14, borderRadius: radii.panel, borderLeftWidth: 4, gap: 8 },
  currentFigures: { flexDirection: "row", gap: 12 },
  lapTile: { flex: 1 },
  lapsEmpty: { marginTop: 18, textAlign: "center" },
  lapRow: { flexDirection: "row", alignItems: "baseline", gap: 10, minHeight: 52, paddingVertical: 12, borderBottomWidth: 1 },
  lapIndex: { width: 28, fontFamily: fonts.figure700, fontSize: 18 },
  lapValue: { flex: 1, fontFamily: fonts.figure700, fontSize: 22, fontVariant: ["tabular-nums"] },
  lapRate: { textAlign: "right" },
  lapUnit: { fontFamily: fonts.figure600, fontSize: 14 },
  shield: { position: "absolute", left: 0, right: 0, top: 0, alignItems: "center" },
  lockBadge: { flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 12, height: 30, borderRadius: 15 },
});
