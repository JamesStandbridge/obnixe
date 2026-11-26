import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppState, Pressable, StyleSheet, View } from "react-native";
import Animated, { FadeIn, FadeOut, useAnimatedStyle, ZoomIn } from "react-native-reanimated";
import type { SharedValue } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Redirect, useFocusEffect, useRouter } from "expo-router";
import { impactAsync, ImpactFeedbackStyle } from "expo-haptics";
import { useLiveQuery } from "drizzle-orm/expo-sqlite";
import {
  distanceToRouteStart,
  finishOpenSessionMutations,
  gearUsage,
  isWorn,
  lastWorkoutOf,
  newGear,
  openSession,
  pairedSensorOf,
  primaryChoice,
  recentSpeedOf,
  recordingSettingsMutation,
  recordingSettingsOf,
  resolveProfile,
  sensorRolesOf,
  signalLevelAccuracy,
  stopwatchProfile,
  workoutEstimate,
} from "@obnixe/core";
import type { LiveSignal, ResolvedProfile } from "@obnixe/core";
import { sportPreference, sports, workoutPlanSchemaFor } from "@obnixe/schema";
import type { FieldValues, Id, Readout, SportKey, WorkoutPlan } from "@obnixe/schema";
import { db, environment } from "@/data/database";
import { updateSettings, useRecordingDisplay } from "@/data/settings";
import { write } from "@/data/write";
import { BottomPanel, Chips, DetailRow, SportStrip, SwitchRow, bottomPanelHeight } from "@/features/activity/components";
import type { SportChoice } from "@/features/activity/components";
import { CatalogueSheet, GearSheet } from "@/features/activity/LogSheets";
import { formatKilometers, gearLabel } from "@/features/activity/presentation";
import { writeGearWear } from "@/features/activity/gearWear";
import type { GeoPoint } from "@/features/maps/tiles";
import { signalWord, SignalBars } from "@/features/recording/LiveParts";
import { SensorCard } from "@/features/recording/SensorParts";
import { QuickIntervalsSheet } from "@/features/recording/QuickIntervalsSheet";
import { defaultGear, hasLiveRecording, lastRecordedSport, recordableSports, slotStartOf } from "@/features/recording/queries";
import { liveReadout, storedReadout } from "@/features/recording/readout";
import { ReadoutEditor } from "@/features/recording/ReadoutEditor";
import { targetLabel } from "@/features/recording/target";
import { startDistanceText } from "@/features/routes/format";
import { RouteOfflineHint } from "@/features/routes/RouteOfflineHint";
import { routeById } from "@/features/routes/routeData";
import { RouteSheet } from "@/features/routes/RouteSheet";
import { useLiveValue } from "@/features/stats/live";
import { BatteryHint } from "@/features/tracking/BatteryHelpScreen";
import { ensureActivityPermission, ensureNotificationPermission, locationAccess, openSystemSettings, requestLocation } from "@/features/tracking/permissions";
import type { LocationAccess } from "@/features/tracking/permissions";
import { recorder, recordingAvailable, useRecorderView } from "@/features/tracking/recorder";
import type { RecorderFailure } from "@/features/tracking/recorderHost";
import { pickReplay, replaySpeeds } from "@/features/tracking/replaySource";
import type { ReplayChoice } from "@/features/tracking/replaySource";
import { estimateText, workoutText } from "@/features/workouts/format";
import { defaultWorkout } from "@/features/workouts/plan";
import { deviceTimeZone } from "@/format/dates";
import { ControlButton, LinkButton, PrimaryButton } from "@/ui/Button";
import { Icon } from "@/ui/icons/Icon";
import { SportIcon } from "@/ui/icons/SportIcon";
import { SportScene } from "@/ui/illustrations/SportScene";
import { IconButton, MenuItem } from "@/ui/Inputs";
import { Screen } from "@/ui/Layout";
import { useLoop } from "@/ui/motion";
import { Sheet } from "@/ui/Overlays";
import { BevelView } from "@/ui/Shapes";
import { useSnackbar } from "@/ui/SnackbarHost";
import { Text } from "@/ui/Text";
import { useTheme } from "@/ui/theme";
import { bevels, fonts, layout } from "@/ui/tokens";

type Access = { readonly kind: "checking" } | LocationAccess;

const countdownSeconds = 3;
const weakSignalNotice = "Signal GPS faible, la distance commencera au premier point fiable";

export interface PrepareScreenProps {
  readonly sport: SportKey | null;
  readonly kind: string | null;
  readonly slotId: Id | null;
  readonly variantId: Id | null;
  /** `RTE-003`: the route to follow, chosen from its screen. */
  readonly routeId: Id | null;
}

function close(router: ReturnType<typeof useRouter>): void {
  if (router.canGoBack()) router.back();
  else router.replace("/");
}

/** `REC-010`, `REC-012`: sport, permissions and GPS readiness before the start; the stopwatch without location (`REC-060`). */
export function PrepareScreen(props: PrepareScreenProps) {
  const view = useRecorderView();
  const [access, setAccess] = useState<Access>({ kind: "checking" });
  const [stopwatchChosen, setStopwatchChosen] = useState(false);
  const recheck = useCallback(() => {
    void locationAccess().then(setAccess);
  }, []);

  useEffect(() => {
    let current = true;
    const check = (): void => {
      void locationAccess().then((next) => {
        if (current) setAccess(next);
      });
    };
    check();
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") check();
    });
    return () => {
      current = false;
      subscription.remove();
    };
  }, []);

  if (view.kind === "recording") return <Redirect href={{ pathname: "/record/[id]", params: { id: view.recording.sessionId } }} />;
  if (!recordingAvailable) return <WebNotice />;
  switch (access.kind) {
    case "checking":
      return null;
    case "granted":
      return <Preparation {...props} located signal={view.kind === "preparing" ? view.signal : null} position={view.kind === "preparing" ? view.position : null} onLocationLost={recheck} />;
    case "unsupported":
      return <WebNotice />;
    case "explain":
    case "approximate":
    case "denied":
      if (stopwatchChosen) return <Preparation {...props} located={false} signal={null} position={null} onLocationLost={recheck} />;
      return <PermissionPrompt access={access} sport={props.sport} onAccess={setAccess} onStopwatch={() => setStopwatchChosen(true)} />;
    default: {
      const unreachable: never = access;
      return unreachable;
    }
  }
}

function WebNotice() {
  const router = useRouter();
  return (
    <Notice
      scene="run"
      title="Enregistre tes activités depuis l'application mobile"
      body="Le suivi GPS en direct fonctionne sur Android et iOS. Ici, tu peux noter une activité à la main."
      primary={{ label: "Noter une activité", run: () => router.replace("/log") }}
      secondary={[]}
    />
  );
}

interface PermissionPromptProps {
  readonly access: Extract<LocationAccess, { readonly kind: "explain" | "approximate" | "denied" }>;
  readonly sport: SportKey | null;
  readonly onAccess: (access: LocationAccess) => void;
  readonly onStopwatch: () => void;
}

/** `PRV-002`, `PRV-003`; without the position, the stopwatch (`REC-060`) or manual entry. */
function PermissionPrompt({ access, sport, onAccess, onStopwatch }: PermissionPromptProps) {
  const router = useRouter();
  const ask = (): void => {
    void requestLocation().then(onAccess);
  };
  const others: readonly NoticeAction[] = [
    { label: "Chronomètre seul", run: onStopwatch },
    { label: "Noter à la main", run: () => router.replace({ pathname: "/log", params: sport === null ? {} : { sport } }) },
  ];
  switch (access.kind) {
    case "explain":
      return (
        <Notice
          scene={sport ?? "run"}
          title="Ta position, pendant la sortie seulement"
          body="Obnixe lit le GPS du début à la fin de l'enregistrement, même écran éteint, pour mesurer distance, allure et dénivelé. La trace reste sur ton téléphone."
          primary={{ label: "Autoriser la localisation", run: ask }}
          secondary={others}
        />
      );
    case "approximate":
      return (
        <Notice
          scene={sport ?? "run"}
          title="Position précise nécessaire"
          body="Avec une position approximative, la distance serait fausse de plusieurs centaines de mètres. Autorise la position exacte pour enregistrer la trace, ou démarre le chronomètre seul."
          primary={access.canAskAgain ? { label: "Autoriser la position exacte", run: ask } : { label: "Ouvrir les réglages", run: openSystemSettings }}
          secondary={others}
        />
      );
    case "denied":
      return (
        <Notice
          scene={sport ?? "run"}
          title="Localisation refusée"
          body="Sans ta position, Obnixe ne peut pas enregistrer de trace. Autorise-la dans les réglages du téléphone, ou enregistre au chronomètre : temps, tours et fréquence cardiaque."
          primary={access.canAskAgain ? { label: "Autoriser la localisation", run: ask } : { label: "Ouvrir les réglages", run: openSystemSettings }}
          secondary={others}
        />
      );
    default: {
      const unreachable: never = access;
      return unreachable;
    }
  }
}

interface NoticeAction {
  readonly label: string;
  readonly run: () => void;
}

interface NoticeProps {
  readonly scene: SportKey;
  readonly title: string;
  readonly body: string;
  readonly primary: NoticeAction;
  readonly secondary: readonly NoticeAction[];
}

function Notice({ scene, title, body, primary, secondary }: NoticeProps) {
  const { colors } = useTheme();
  const router = useRouter();
  return (
    <View style={[styles.root, { backgroundColor: colors.bg }]}>
      <Screen bottomInset={bottomPanelHeight + 40}>
        <View style={styles.appbar}>
          <IconButton icon="close" label="Fermer" edge="start" onPress={() => close(router)} />
        </View>
        <View style={styles.noticeScene}>
          <SportScene sport={scene} size={180} />
        </View>
        <Text variant="title" accessibilityRole="header" style={styles.noticeTitle}>
          {title}
        </Text>
        <Text variant="body" tone="secondary" style={styles.noticeBody}>
          {body}
        </Text>
      </Screen>
      <BottomPanel>
        <View style={styles.noticeActions}>
          <PrimaryButton label={primary.label} onPress={primary.run} />
          {secondary.map((action) => (
            <LinkButton key={action.label} label={action.label} onPress={action.run} style={styles.noticeLink} />
          ))}
        </View>
      </BottomPanel>
    </View>
  );
}

interface PreparationProps extends PrepareScreenProps {
  /** False once the stopwatch was chosen without the position (`REC-060`). */
  readonly located: boolean;
  readonly signal: LiveSignal | null;
  readonly position: GeoPoint | null;
  readonly onLocationLost: () => void;
}

type PrepareSheet =
  | { readonly kind: "none" }
  | { readonly kind: "catalogue" }
  | { readonly kind: "gear" }
  | { readonly kind: "route" }
  | { readonly kind: "replay" }
  | { readonly kind: "quick"; readonly initial: WorkoutPlan; readonly opening: number }
  | { readonly kind: "open"; readonly sessionId: Id };

/** Whether the plan can guide a recording of the profile (`WKT-002`). */
function fits(plan: WorkoutPlan, profile: ResolvedProfile | null): boolean {
  return profile !== null && workoutPlanSchemaFor(profile.primary).safeParse(plan).success;
}

function Preparation({ sport: requested, kind: requestedKind, slotId, variantId, routeId: requestedRoute, located, signal, position, onLocationLost }: PreparationProps) {
  const { colors } = useTheme();
  const router = useRouter();
  const notify = useSnackbar();
  const display = useRecordingDisplay();
  const { data: preferences } = useLiveQuery(db().select().from(sportPreference));
  const recordable = useMemo(() => recordableSports(preferences), [preferences]);
  const start = useMemo(() => (slotId === null ? null : slotStartOf(slotId, variantId)), [slotId, variantId]);

  const [sport, setSport] = useState<SportKey>(() => {
    if (requested !== null && sports[requested].recording !== null) return requested;
    if (start !== null && sports[start.slot.sport].recording !== null) return start.slot.sport;
    return lastRecordedSport(recordableSports(db().select().from(sportPreference).all())) ?? "run";
  });
  const [values, setValues] = useState<FieldValues>(() => (requestedKind !== null ? { kind: requestedKind } : start !== null && start.slot.sport === sport ? start.values : {}));
  const kind = typeof values.kind === "string" ? values.kind : null;
  const [gearId, setGearId] = useState<Id | null>(() => defaultGear(sport, kind));
  const [gearVersion, setGearVersion] = useState(0);
  const [sheet, setSheet] = useState<PrepareSheet>({ kind: "none" });
  const [routeId, setRouteId] = useState<Id | null>(requestedRoute);
  const chosenRoute = useLiveValue(() => (routeId === null ? null : routeById(routeId)), ["route"], [routeId]);
  const followed = chosenRoute !== null && chosenRoute.deletedAt === null && chosenRoute.sport === sport ? chosenRoute : null;
  const [counting, setCounting] = useState(false);
  const [starting, setStarting] = useState(false);
  const [programGuided, setProgramGuided] = useState(true);
  const [quick, setQuick] = useState<WorkoutPlan | null>(null);
  const [replay, setReplay] = useState<ReplayChoice | null>(null);
  const launched = useRef(false);

  const definition = sports[sport];
  const trackProfile = useMemo(() => resolveProfile(sport, values), [sport, values]);
  const stopwatch = !located || trackProfile === null;
  const profile = useMemo(() => (stopwatch ? stopwatchProfile(sport, values) : trackProfile), [stopwatch, trackProfile, sport, values]);
  const settings = useMemo(() => (profile === null ? null : recordingSettingsOf(db(), profile)), [profile, preferences]);
  const firstRecording = useMemo(() => !hasLiveRecording(), []);
  const [autoPause, setAutoPause] = useState<{ readonly sport: SportKey; readonly value: boolean } | null>(null);
  const autoPauseOn = autoPause?.sport === sport ? autoPause.value : (settings?.autoPause ?? false);
  const readout = profile === null || settings === null ? null : liveReadout(profile, settings, false);
  const gear = useMemo(() => (definition.usesGear ? gearUsage(db(), sport) : []), [definition.usesGear, sport, gearVersion]);
  const selectedGear = gear.find((item) => item.gear.id === gearId);
  const choice = primaryChoice(definition);
  const slotApplies = start !== null && start.slot.sport === sport;
  const goodFix = signal !== null && signal.accuracy !== null && signal.accuracy <= signalLevelAccuracy.fair;
  const referenceSpeedMmS = useMemo(() => (profile === null ? null : recentSpeedOf(db(), sport)), [profile === null, sport]);
  const programWorkout = !stopwatch && slotApplies && start?.workout != null && fits(start.workout, profile) ? start.workout : null;
  const quickWorkout = !stopwatch && quick !== null && fits(quick, profile) ? quick : null;
  const workout = quickWorkout ?? (programGuided ? programWorkout : null);

  useFocusEffect(
    useCallback(() => {
      if (profile === null || stopwatch) return undefined;
      void recorder.prepare().then((outcome) => {
        if (!outcome.ok && outcome.failure.kind === "location_denied") onLocationLost();
      });
      return () => {
        if (!launched.current) recorder.cancelPreparation();
      };
    }, [profile === null, stopwatch, onLocationLost]),
  );

  const stripKeys = useMemo(() => {
    const top = recordable.slice(0, 3);
    return top.includes(sport) ? top : [...top.slice(0, 2), sport];
  }, [recordable, sport]);
  const strip: SportChoice[] = [...stripKeys.map((key) => ({ key, label: sports[key].label })), ...(recordable.length > stripKeys.length ? [{ key: "catalogue" as const, label: "Autre…" }] : [])];

  const switchSport = (next: SportKey): void => {
    setSheet({ kind: "none" });
    if (next === sport) return;
    const nextValues = start !== null && start.slot.sport === next ? start.values : {};
    if (quick !== null && !fits(quick, resolveProfile(next, nextValues))) setQuick(null);
    setSport(next);
    setValues(nextValues);
    setGearId(defaultGear(next, typeof nextValues.kind === "string" ? nextValues.kind : null));
  };

  const chooseKind = (key: string): void => {
    if (choice === null || values[choice.key] === key) return;
    setValues({ ...values, [choice.key]: key });
    if (choice.key === "kind") setGearId(defaultGear(sport, key));
  };

  const saveReadout = (next: Readout | null): void => {
    if (profile === null || settings === null) return;
    const stored = next === null ? null : storedReadout(profile, settings, next);
    write(`Écran de direct : ${definition.label.toLowerCase()}`, [recordingSettingsMutation(db(), sport, { ...settings, readout: stored === null ? null : { main: stored.main, secondary: [...stored.secondary] } })]);
  };

  const createGear = (name: string): void => {
    const plan = newGear(environment, sport, name);
    write(`${gearLabel(sport)} : ${name.trim()}`, [plan.mutation]);
    setGearId(plan.gearId);
    setGearVersion((version) => version + 1);
    setSheet({ kind: "none" });
  };

  const failed = (failure: RecorderFailure): void => {
    switch (failure.kind) {
      case "open_session":
        setSheet({ kind: "open", sessionId: failure.sessionId });
        return;
      case "storage_full":
        notify({ text: "Stockage plein : libère de la place pour enregistrer", aboveTabBar: false, extraOffset: bottomPanelHeight });
        return;
      case "route_unavailable":
        setRouteId(null);
        notify({ text: "Itinéraire illisible ou supprimé : choisis-en un autre", aboveTabBar: false, extraOffset: bottomPanelHeight });
        return;
      case "location_denied":
        onLocationLost();
        return;
      case "busy":
      case "no_recording":
      case "unsupported":
      case "refused":
      case "not_extendable":
      case "failed":
        notify({ text: "Démarrage impossible, réessaie", aboveTabBar: false, extraOffset: bottomPanelHeight });
        return;
      default: {
        const unreachable: never = failure;
        return unreachable;
      }
    }
  };

  const launch = async (): Promise<void> => {
    if (profile === null) return;
    launched.current = true;
    const outcome = await recorder.start({
      request: {
        sport,
        values,
        gearId,
        slot: slotApplies && start !== null ? { slotId: start.slot.id, variantId: start.variantId, countsInRotation: true } : null,
        timeZone: deviceTimeZone(),
        routeId: stopwatch ? null : (followed?.id ?? null),
        workout,
        stopwatch,
      },
      autoPause: !stopwatch && autoPauseOn,
      power: "normal",
      replay: stopwatch ? null : (replay?.replay ?? null),
    });
    setStarting(false);
    if (outcome.ok) {
      if (!goodFix && !stopwatch && replay === null) notify({ text: weakSignalNotice, aboveTabBar: false, extraOffset: 120 });
      router.replace({ pathname: "/record/[id]", params: { id: outcome.value } });
      return;
    }
    launched.current = false;
    failed(outcome.failure);
  };

  const begin = async (): Promise<void> => {
    if (profile === null || starting) return;
    setStarting(true);
    await ensureNotificationPermission();
    if (profile.cadence === "steps") await ensureActivityPermission(profile);
    if (display.countdown) {
      setCounting(true);
      return;
    }
    await launch();
  };

  const finishOpen = (): void => {
    const open = openSession(db());
    setSheet({ kind: "none" });
    if (open === null) return;
    write("Séance terminée", finishOpenSessionMutations(open));
    void begin();
  };

  const target = slotApplies ? (start?.target ?? null) : null;

  return (
    <View style={[styles.root, { backgroundColor: colors.bg }]}>
      <Screen bottomInset={bottomPanelHeight + 60}>
        <View style={styles.appbar}>
          <IconButton icon="close" label="Fermer sans démarrer" edge="start" onPress={() => close(router)} />
          <Text variant="label" tone="secondary" style={styles.context} accessibilityRole="header">
            Nouvelle sortie
          </Text>
        </View>

        {slotApplies && start !== null ? (
          <View style={[styles.slot, { borderColor: colors.line }]}>
            <SportIcon sport={start.slot.sport} variant="badge" />
            <View style={styles.slotText}>
              <Text variant="eyebrow" tone="secondary">
                Séance du programme
              </Text>
              <Text variant="heading" numberOfLines={1}>
                {start.variantName === null ? start.slot.name : `${start.slot.name} · ${start.variantName}`}
              </Text>
              {target === null ? null : (
                <Text variant="small" tone="secondary">
                  Objectif {targetLabel(target)}
                </Text>
              )}
            </View>
          </View>
        ) : null}

        <View style={styles.sports}>
          <SportStrip items={strip} value={sport} onChange={(key) => (key === "catalogue" ? setSheet({ kind: "catalogue" }) : switchSport(key))} />
        </View>

        {choice === null ? null : (
          <View style={styles.kind}>
            <Text variant="sectionTitle" tone="secondary">
              {choice.label}
            </Text>
            <Chips
              label={choice.label}
              multiple={false}
              compact
              options={choice.options.filter((option) => option.retired !== true).map((option) => ({ value: option.key, label: option.label }))}
              selected={typeof values[choice.key] === "string" ? [values[choice.key] as string] : []}
              onToggle={chooseKind}
            />
          </View>
        )}

        {profile === null ? null : (
          <>
            {stopwatch ? (
              <StopwatchCard
                located={located}
                label={definition.label}
                distanceUnit={profile.pacePerMeters === 100 ? "m" : "km"}
                heartRate={profile.metrics.includes("heart_rate")}
                onManual={() => router.replace({ pathname: "/log", params: { sport, ...(slotApplies && start !== null ? { slotId: start.slot.id } : {}) } })}
              />
            ) : (
              <SignalCard signal={signal} />
            )}
            {sensorRolesOf(profile)
              .filter((role) => !stopwatch || role === "heart_rate")
              .map((role) => {
                const device = settings === null ? null : pairedSensorOf(profile, settings, role);
                return role === "heart_rate" || device !== null ? <SensorCard key={role} role={role} profile={profile} device={device} /> : null;
              })}
            {firstRecording ? <BatteryHint /> : null}

            <View style={styles.options}>
              {definition.usesGear ? (
                <DetailRow
                  title={gearLabel(sport)}
                  value={selectedGear === undefined ? null : `${selectedGear.gear.name} · ${formatKilometers(selectedGear.meters)}${isWorn(selectedGear) ? " · usure atteinte" : ""}`}
                  onPress={() => setSheet({ kind: "gear" })}
                />
              ) : null}
              {stopwatch ? null : (
                <DetailRow
                  title="Itinéraire"
                  value={followed === null ? "Aucun" : position === null ? followed.name : `${followed.name} · ${startDistanceText(distanceToRouteStart(followed, position))}`}
                  onPress={() => setSheet({ kind: "route" })}
                />
              )}
              {programWorkout === null ? null : (
                <SwitchRow
                  title="Séance guidée"
                  detail={guidedDetail(programWorkout, referenceSpeedMmS)}
                  value={programGuided && quickWorkout === null}
                  onChange={(value) => {
                    setProgramGuided(value);
                    if (value) setQuick(null);
                  }}
                />
              )}
              {stopwatch ? null : (
                <>
                  <DetailRow
                    title="Fractionné rapide"
                    value={quickWorkout === null ? null : (estimateText(workoutEstimate(quickWorkout, referenceSpeedMmS)) ?? workoutText(quickWorkout))}
                    onPress={() => setSheet({ kind: "quick", initial: quickWorkout ?? quickStart(sport, profile), opening: Date.now() })}
                  />
                  <SwitchRow title="Pause automatique" detail="Pour cette sortie" value={autoPauseOn} onChange={(value) => setAutoPause({ sport, value })} />
                </>
              )}
              {__DEV__ && !stopwatch ? (
                <DetailRow title="Source de position (dev)" value={replay === null ? "GPS du téléphone" : `Rejeu ${replay.replay.speed}× · ${replay.name}`} onPress={() => setSheet({ kind: "replay" })} />
              ) : null}
              <SwitchRow title="Décompte de 3 secondes" detail="Avant le départ" value={display.countdown} onChange={(value) => updateSettings({ countdown: value })} />
              <SwitchRow title="Garder l'écran allumé" detail="Pendant l'enregistrement" value={display.keepScreenOn} onChange={(value) => updateSettings({ keepScreenOn: value })} />
            </View>
            {followed === null ? null : <RouteOfflineHint route={followed} />}

            {stopwatch || readout === null || settings === null ? null : (
              <ReadoutEditor profile={profile} readout={readout} customized={settings.readout !== null} onChange={saveReadout} onReset={() => saveReadout(null)} />
            )}
            <LinkButton label={`Alertes et réglages · ${definition.label}`} onPress={() => router.push({ pathname: "/settings/recording/[sport]", params: { sport } })} style={styles.settingsLink} />
          </>
        )}
      </Screen>

      {profile === null ? null : (
        <BottomPanel>
          {goodFix || stopwatch || replay !== null ? null : (
            <Text variant="caption" tone="secondary" style={styles.weak}>
              {signal?.level === "weak" ? weakSignalNotice : "Recherche du signal GPS : tu peux démarrer quand tu veux"}
            </Text>
          )}
          <PrimaryButton label={stopwatch ? "Démarrer le chronomètre" : "Démarrer"} disabled={starting} icon={<Icon name="play" size={20} color={starting ? colors.text2 : colors.actInk} />} onPress={() => void begin()} />
        </BottomPanel>
      )}

      {counting ? (
        <Countdown
          onDone={() => {
            setCounting(false);
            void launch();
          }}
          onCancel={() => {
            setCounting(false);
            setStarting(false);
          }}
        />
      ) : null}

      <CatalogueSheet open={sheet.kind === "catalogue"} sports={recordable.filter((key) => !stripKeys.includes(key))} labelOf={(key) => sports[key].label} onChoose={switchSport} onClose={() => setSheet({ kind: "none" })} />
      <GearSheet
        open={sheet.kind === "gear"}
        title={gearLabel(sport)}
        items={gear}
        selected={gearId}
        onSelect={(next) => {
          setGearId(next);
          setSheet({ kind: "none" });
        }}
        onCreate={createGear}
        onSetWear={(item, wearMeters) => {
          if (writeGearWear(item, wearMeters)) setGearVersion((version) => version + 1);
        }}
        onClose={() => setSheet({ kind: "none" })}
      />
      <RouteSheet
        open={sheet.kind === "route"}
        sport={sport}
        sportLabel={definition.label}
        position={position}
        onSelect={(next) => {
          setRouteId(next);
          setSheet({ kind: "none" });
        }}
        onClose={() => setSheet({ kind: "none" })}
      />
      {profile === null ? null : (
        <QuickIntervalsSheet
          open={sheet.kind === "quick"}
          opening={sheet.kind === "quick" ? sheet.opening : 0}
          initial={sheet.kind === "quick" ? sheet.initial : defaultWorkout(profile.primary)}
          measure={profile.primary}
          referenceSpeedMmS={referenceSpeedMmS}
          chosen={quickWorkout !== null}
          onUse={(plan) => {
            setQuick(plan);
            setSheet({ kind: "none" });
          }}
          onClear={() => {
            setQuick(null);
            setSheet({ kind: "none" });
          }}
          onClose={() => setSheet({ kind: "none" })}
        />
      )}
      {__DEV__ ? (
        <Sheet open={sheet.kind === "replay"} title="Source de position" context="Build de développement" onClose={() => setSheet({ kind: "none" })}>
          <View>
            <MenuItem
              label="GPS du téléphone"
              onPress={() => {
                setReplay(null);
                setSheet({ kind: "none" });
              }}
            />
            {replaySpeeds.map((speed) => (
              <MenuItem
                key={speed}
                label={speed === 1 ? "Rejouer un GPX en temps réel" : `Rejouer un GPX ${speed}× plus vite`}
                detail={speed === 1 ? "Reprend après un arrêt du processus" : "Ne survit pas à un arrêt du processus"}
                onPress={() => {
                  setSheet({ kind: "none" });
                  void pickReplay(speed).then((choice) => {
                    if (choice !== null) setReplay(choice);
                  });
                }}
              />
            ))}
          </View>
        </Sheet>
      ) : null}
      <Sheet open={sheet.kind === "open"} title="Une séance est déjà ouverte" context="Une seule activité à la fois" onClose={() => setSheet({ kind: "none" })}>
        <View>
          <MenuItem
            label="Voir la séance ouverte"
            onPress={() => {
              if (sheet.kind !== "open") return;
              setSheet({ kind: "none" });
              router.push({ pathname: "/session/[id]", params: { id: sheet.sessionId } });
            }}
          />
          <MenuItem label="La terminer et démarrer" detail="Elle garde ce qui est déjà noté" onPress={finishOpen} />
        </View>
      </Sheet>
    </View>
  );
}

function guidedDetail(plan: WorkoutPlan, referenceSpeedMmS: number | null): string {
  const estimate = estimateText(workoutEstimate(plan, referenceSpeedMmS));
  return estimate === null ? workoutText(plan) : `${estimate} · ${workoutText(plan)}`;
}

/** `WKT-008`: the last guided workout of the sport when it still fits, else the default intervals. */
function quickStart(sport: SportKey, profile: ResolvedProfile): WorkoutPlan {
  const last = lastWorkoutOf(db(), sport);
  return last !== null && fits(last, profile) ? last : defaultWorkout(profile.primary);
}

interface StopwatchCardProps {
  readonly located: boolean;
  readonly label: string;
  readonly distanceUnit: "m" | "km";
  readonly heartRate: boolean;
  readonly onManual: () => void;
}

/** `REC-060`: what a recording without position measures. */
function StopwatchCard({ located, label, distanceUnit, heartRate, onManual }: StopwatchCardProps) {
  const { colors } = useTheme();
  const measured = heartRate ? "le temps, les pauses, les tours et la fréquence cardiaque d'un capteur appairé" : "le temps, les pauses et les tours";
  return (
    <BevelView fill={colors.surface} cut={bevels.card} band={{ color: colors.mark, height: 4 }} style={styles.stopwatch}>
      <Text variant="heading">Chronomètre seul</Text>
      <Text variant="body" tone="secondary">
        {`${located ? `Pas de trace GPS pour cette option de ${label.toLowerCase()}` : "Sans localisation"} : ${measured} sont enregistrés. Tu pourras saisir la distance en ${distanceUnit === "m" ? "mètres" : "kilomètres"} à la fin.`}
      </Text>
      <ControlButton label="Noter à la main plutôt" onPress={onManual} style={styles.stopwatchButton} />
    </BevelView>
  );
}

interface SignalCardProps {
  readonly signal: LiveSignal | null;
}

function SignalCard({ signal }: SignalCardProps) {
  const { colors } = useTheme();
  const pulse = useLoop(1600);
  const level = signal?.level ?? "none";
  const searching = level === "none";
  const title = searching ? "Recherche du signal GPS…" : level === "weak" ? "Signal GPS faible" : level === "fair" ? "Signal GPS correct" : "Signal GPS prêt";
  const detail = signal?.accuracy == null ? "Reste à découvert, loin des bâtiments" : `Précision ±${Math.round(signal.accuracy)} m`;
  const tone = level === "good" || level === "fair" ? colors.mark : level === "weak" ? colors.warn : colors.text3;
  return (
    <BevelView fill={colors.surface} cut={bevels.card} band={{ color: tone, height: 4 }} style={styles.signal}>
      <View style={styles.signalIcon} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
        {searching ? <Pulse progress={pulse} color={colors.text2} /> : null}
        <Icon name="locate" size={26} color={searching ? colors.text2 : tone} />
      </View>
      <View style={styles.signalText} accessible accessibilityLiveRegion="polite" accessibilityLabel={`${title}. ${detail}`}>
        <Text variant="heading">{title}</Text>
        <Text variant="small" tone="secondary">
          {detail}
        </Text>
      </View>
      <View style={styles.signalBars}>
        <SignalBars level={level} size={22} />
        <Text variant="caption" tone="secondary">
          {signalWord(level)}
        </Text>
      </View>
    </BevelView>
  );
}

interface PulseProps {
  readonly progress: SharedValue<number>;
  readonly color: string;
}

function Pulse({ progress, color }: PulseProps) {
  const style = useAnimatedStyle(() => ({ opacity: 0.7 * (1 - progress.value), transform: [{ scale: 0.6 + progress.value * 0.9 }] }));
  return <Animated.View style={[styles.pulse, { borderColor: color }, style]} />;
}

interface CountdownProps {
  readonly onDone: () => void;
  readonly onCancel: () => void;
}

/** `REC-013`. */
function Countdown({ onDone, onCancel }: CountdownProps) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const [left, setLeft] = useState(countdownSeconds);
  const done = useRef(onDone);
  done.current = onDone;

  useEffect(() => {
    void impactAsync(left === 0 ? ImpactFeedbackStyle.Heavy : ImpactFeedbackStyle.Medium);
    if (left === 0) {
      done.current();
      return undefined;
    }
    const timer = setTimeout(() => setLeft(left - 1), 1000);
    return () => clearTimeout(timer);
  }, [left]);

  return (
    <Animated.View entering={FadeIn.duration(160)} exiting={FadeOut.duration(160)} style={[styles.countdown, { backgroundColor: colors.bg, paddingBottom: insets.bottom + 24 }]}>
      <Text variant="eyebrow" tone="secondary">
        Départ dans
      </Text>
      <Animated.View key={left} entering={ZoomIn.duration(260)}>
        <Text style={[styles.countdownValue, { color: left === 0 ? colors.mark : colors.text }]} accessibilityLiveRegion="assertive">
          {left === 0 ? "Go" : String(left)}
        </Text>
      </Animated.View>
      <Pressable accessibilityRole="button" onPress={onCancel} style={({ pressed }) => [styles.countdownCancel, { backgroundColor: pressed ? colors.surfacePress : colors.surface2 }]}>
        <Text variant="label">Annuler</Text>
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  appbar: { flexDirection: "row", alignItems: "center", gap: 12, minHeight: 44 },
  context: { flex: 1 },
  slot: { flexDirection: "row", alignItems: "center", gap: 12, marginTop: 12, paddingVertical: 12, borderTopWidth: 1, borderBottomWidth: 1 },
  slotText: { flex: 1, minWidth: 0, gap: 2 },
  sports: { marginTop: 12 },
  kind: { marginTop: 16, gap: 8 },
  signal: { marginTop: 20, padding: 16, paddingTop: 18, flexDirection: "row", alignItems: "center", gap: 14 },
  signalIcon: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  pulse: { position: "absolute", width: 44, height: 44, borderRadius: 22, borderWidth: 2 },
  signalText: { flex: 1, minWidth: 0, gap: 3 },
  signalBars: { alignItems: "center", gap: 4 },
  options: { marginTop: 12 },
  settingsLink: { alignSelf: "center", marginTop: 20 },
  stopwatch: { marginTop: 20, padding: 18, paddingTop: 20, gap: 8 },
  stopwatchButton: { alignSelf: "flex-start", marginTop: 6 },
  weak: { textAlign: "center", marginBottom: 8 },
  noticeScene: { marginTop: 24, height: 180, alignItems: "center", justifyContent: "center" },
  noticeTitle: { marginTop: 24 },
  noticeBody: { marginTop: 12 },
  noticeActions: { gap: 6 },
  noticeLink: { alignSelf: "center" },
  countdown: { ...StyleSheet.absoluteFill, alignItems: "center", justifyContent: "center", gap: 8, paddingHorizontal: layout.gutter },
  countdownValue: { fontFamily: fonts.figure800, fontSize: 180, lineHeight: 190, letterSpacing: -4 },
  countdownCancel: { position: "absolute", bottom: 48, minHeight: 48, minWidth: 140, borderRadius: 24, alignItems: "center", justifyContent: "center", paddingHorizontal: 24 },
});
