import { useEffect, useMemo, useRef, useState } from "react";
import { Animated, Pressable, ScrollView, StyleSheet, View } from "react-native";
import type { ScrollViewInstance } from "react-native";
import { notificationAsync, NotificationFeedbackType, impactAsync, ImpactFeedbackStyle } from "expo-haptics";
import { useKeepAwake } from "expo-keep-awake";
import { router, useNavigation } from "expo-router";
import type { NativeStackNavigationProp } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  addExerciseMutations,
  bringForwardMutations,
  correctSetMutations,
  draftFor,
  durationStepSeconds,
  finishMutations,
  gramsToMass,
  hasPendingDuringPain,
  interruptMutations,
  InvalidSetError,
  isPainful,
  loadWorkout,
  logSetMutations,
  massToGrams,
  postponeEntryMutations,
  previousSetAt,
  replaceExerciseMutations,
  painReportMutations,
  skipEntryMutations,
  stopEntryMutations,
  stoppedZones,
  workoutProgress,
  worstLevel,
  activeSeconds,
} from "@obnixe/core";
import type { Mutation, WorkoutExercise } from "@obnixe/core";
import { settings, sports, zoneKeys } from "@obnixe/schema";
import type { EpochMs, Exercise, Id, PainLevel, StrengthSet, ZoneKey } from "@obnixe/schema";
import { db, environment } from "@/data/database";
import { useUndoableWrite, write } from "@/data/write";
import { equipmentLabels, formatClock, formatLongClock, formatMass, lowerFirst, zoneLabel } from "@/features/training/format";
import { freeStrengthTitle } from "@/features/training/sessionText";
import { useMassUnit, useNow } from "@/features/training/useLiveLoad";
import { ExerciseSheet } from "@/features/training/workout/ExerciseSheet";
import type { ExerciseSheetMode } from "@/features/training/workout/ExerciseSheet";
import {
  describeComparison,
  durationLimit,
  isDraftValid,
  liveProgression,
  loadLimits,
  repsLimit,
  setText,
  stepGramsFor,
  targetText,
} from "@/features/training/workout/liveWorkout";
import type { Draft, LiveWorkout } from "@/features/training/workout/liveWorkout";
import { PadSheet } from "@/features/training/workout/PadSheet";
import type { PadRequest } from "@/features/training/workout/PadSheet";
import { PainSheet } from "@/features/training/workout/PainSheet";
import type { PainStep, PainZoneOption } from "@/features/training/workout/PainSheet";
import { Readout } from "@/features/training/workout/Readout";
import type { DraftKey } from "@/features/training/workout/Readout";
import { RestBand } from "@/features/training/workout/RestBand";
import type { Band } from "@/features/training/workout/RestBand";
import { Steps, Track, UpNext } from "@/features/training/workout/WorkoutParts";
import { ControlButton, LinkButton, PrimaryButton } from "@/ui/Button";
import { PainMark } from "@/ui/Controls";
import { Icon } from "@/ui/icons/Icon";
import { IconButton } from "@/ui/Inputs";
import { usePressScale } from "@/ui/motion";
import { useSnackbar } from "@/ui/SnackbarHost";
import { Text } from "@/ui/Text";
import { useTheme } from "@/ui/theme";
import { fonts, layout, radii } from "@/ui/tokens";

interface Editing {
  readonly setId: Id;
  readonly index: number;
  readonly draft: Draft;
}

interface Override {
  readonly key: string;
  readonly values: Partial<Draft>;
}

interface ActiveSet {
  readonly key: string;
  readonly startedAt: number;
}

interface RestAdjust {
  readonly setId: Id | null;
  readonly delta: number;
}

interface PainTarget {
  readonly phase: "during" | "between";
  readonly strengthSetId: Id | null;
  readonly label: string;
  readonly exerciseIndex: number;
}

interface PainState {
  readonly open: boolean;
  readonly step: PainStep;
  readonly target: PainTarget | null;
  readonly pending: ReadonlyMap<ZoneKey, PainLevel>;
  readonly stopTitle: string;
}

const closedPain: PainState = { open: false, step: "zones", target: null, pending: new Map(), stopTitle: "" };
const overdueAfterSeconds = 30 * 60;
const stripHeight = 58;

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function correctionSummary(before: StrengthSet, after: Draft, unit: "kg" | "lb"): string {
  const parts: string[] = [];
  if (before.loadGrams !== after.loadGrams && after.loadGrams !== null) parts.push(`${formatMass(before.loadGrams ?? 0, unit)} → ${formatMass(after.loadGrams, unit)} ${unit}`);
  if (before.reps !== after.reps && after.reps !== null) parts.push(`${before.reps ?? 0} → ${after.reps} rép.`);
  if (before.durationSeconds !== after.durationSeconds && after.durationSeconds !== null) parts.push(`${formatClock(before.durationSeconds ?? 0)} → ${formatClock(after.durationSeconds)}`);
  if (before.rir !== after.rir) parts.push(`RIR ${before.rir ?? "–"} → ${after.rir ?? "–"}`);
  return parts.length === 0 ? "sans changement" : parts.join(", ");
}

interface LiveWorkoutScreenProps {
  readonly live: LiveWorkout;
}

export function LiveWorkoutScreen({ live }: LiveWorkoutScreenProps) {
  useKeepAwake(undefined, { suppressDeactivateWarnings: true });
  const { colors, name: palette, reduceMotion } = useTheme();
  const insets = useSafeAreaInsets();
  const unit = useMassUnit();
  const now = useNow(1000);
  const notify = useSnackbar();
  const undoableWrite = useUndoableWrite();
  const navigation = useNavigation<NativeStackNavigationProp<Record<string, object | undefined>>>();
  const scrollRef = useRef<ScrollViewInstance>(null);
  const leaving = useRef(false);
  const [panelHeight, setPanelHeight] = useState(160);

  const { data } = live;
  const sessionId = data.session.id;
  const progress = workoutProgress(data);
  const finished = progress.currentIndex === null;
  const displayIndex = progress.currentIndex ?? Math.max(0, data.exercises.length - 1);
  const display: WorkoutExercise | undefined = data.exercises[displayIndex];
  const setIndex = progress.setIndex;
  const draftKey = display === undefined ? "" : `${display.entry.id}:${setIndex}`;
  const stepGrams = display === undefined ? 1000 : stepGramsFor(display.exercise, unit);

  const [editingState, setEditing] = useState<Editing | null>(null);
  const editing = editingState !== null && display?.sets.some((set) => set.id === editingState.setId) === true ? editingState : null;
  const [override, setOverride] = useState<Override>({ key: "", values: {} });
  const [activeSet, setActiveSet] = useState<ActiveSet | null>(null);
  const [restAdjust, setRestAdjust] = useState<RestAdjust>({ setId: null, delta: 0 });
  const [pain, setPain] = useState<PainState>(closedPain);
  const [pad, setPad] = useState<{ readonly key: DraftKey; readonly request: PadRequest } | null>(null);
  const [sheet, setSheet] = useState<{ readonly open: boolean; readonly mode: ExerciseSheetMode }>({ open: false, mode: "menu" });

  const progression = useMemo(() => (display === undefined ? null : liveProgression(live, display, unit)), [live, display, unit]);
  const base = progression === null || display === undefined ? null : draftFor(progression, display.sets, setIndex);
  const own = override.key === draftKey ? override.values : {};
  const draft: Draft = { loadGrams: base?.loadGrams ?? null, reps: base?.reps ?? null, durationSeconds: base?.durationSeconds ?? null, rir: null, ...own };
  const proposes = progression !== null && (progression.kind === "increase_load" || progression.kind === "add_reps" || progression.kind === "first");
  const suggested = proposes && base?.suggested === true && own.loadGrams === undefined && own.reps === undefined && own.durationSeconds === undefined;
  const activeDraft = editing?.draft ?? draft;
  const active = activeSet !== null && activeSet.key === draftKey && !finished ? activeSet : null;

  const lastSet = progress.lastSet;
  const restTotal = lastSet !== null && progress.restSeconds !== null ? progress.restSeconds + (restAdjust.setId === lastSet.set.id ? restAdjust.delta : 0) : null;
  const restElapsed = lastSet === null ? 0 : Math.max(0, Math.floor((now - lastSet.set.completedAt) / 1000));
  const band: Band = (() => {
    if (finished) return { kind: "idle" };
    if (active !== null) return { kind: "active", label: `Série ${setIndex + 1} en cours`, elapsed: Math.max(0, Math.floor((now - active.startedAt) / 1000)) };
    if (restTotal === null) return { kind: "idle" };
    const remaining = restTotal - restElapsed;
    if (remaining > 0) return { kind: "running", remaining, total: restTotal };
    if (-remaining > overdueAfterSeconds) return { kind: "idle" };
    return { kind: "done", over: -remaining };
  })();

  const stripShown = band.kind === "running" || band.kind === "done";
  const placement = { aboveTabBar: false, extraOffset: Math.max(0, panelHeight - insets.bottom + (stripShown ? 0 : stripHeight)) } as const;

  const previousBand = useRef(band.kind);
  useEffect(() => {
    if (previousBand.current === "running" && band.kind === "done") void notificationAsync(NotificationFeedbackType.Success);
    previousBand.current = band.kind;
  }, [band.kind]);

  useEffect(() => {
    const unsubscribe = navigation.addListener("removed", () => {
      if (leaving.current) return;
      const current = loadWorkout(db(), sessionId);
      if (current === null || current.session.status !== "in_progress") return;
      const at = environment.now();
      if (current.exercises.length > 0 && workoutProgress(current).currentIndex === null) write("Séance terminée", finishMutations(current, at));
      else write("Séance interrompue", interruptMutations(current.session, at));
    });
    return () => queueMicrotask(unsubscribe);
  }, [navigation, sessionId]);

  const sessionTitle = data.slot === null ? freeStrengthTitle : data.variant === null ? data.slot.name : `${data.slot.name} · ${data.variant.name}`;
  const empty = data.exercises.length === 0;
  const pendingOthers = (entryId: Id): number => data.exercises.filter((candidate) => candidate.entry.status === "pending" && candidate.entry.id !== entryId).length;

  const updateDraft = (patch: Partial<Draft>): void => {
    if (editing !== null) {
      setEditing({ ...editing, draft: { ...editing.draft, ...patch } });
      return;
    }
    setOverride((current) => ({ key: draftKey, values: { ...(current.key === draftKey ? current.values : {}), ...patch } }));
  };

  const adjust = (key: DraftKey, direction: 1 | -1): boolean => {
    switch (key) {
      case "load": {
        const next = (activeDraft.loadGrams ?? 0) + direction * stepGrams;
        const shown = gramsToMass(next, unit);
        if (shown < 0 || shown > loadLimits[unit]) return false;
        updateDraft({ loadGrams: Math.max(0, next) });
        return true;
      }
      case "reps": {
        const next = (activeDraft.reps ?? 0) + direction;
        if (next < 0 || next > repsLimit) return false;
        updateDraft({ reps: next });
        return true;
      }
      case "duration": {
        const next = (activeDraft.durationSeconds ?? 0) + direction * durationStepSeconds;
        if (next < 0 || next > durationLimit) return false;
        updateDraft({ durationSeconds: next });
        return true;
      }
      default: {
        const unreachable: never = key;
        return unreachable;
      }
    }
  };

  const previousSet = progression === null ? null : previousSetAt(progression, editing?.index ?? setIndex);

  const openPad = (key: DraftKey): void => {
    if (display === undefined) return;
    switch (key) {
      case "load":
        setPad({
          key,
          request: {
            title: `Charge · ${equipmentLabels[display.exercise.equipment]}`,
            unit,
            decimals: 1,
            current: gramsToMass(activeDraft.loadGrams ?? 0, unit),
            previous: previousSet === null || previousSet.loadGrams === null ? null : gramsToMass(previousSet.loadGrams, unit),
            max: loadLimits[unit],
          },
        });
        return;
      case "reps":
        setPad({ key, request: { title: "Répétitions", unit: "rép.", decimals: 0, current: activeDraft.reps ?? 0, previous: previousSet?.reps ?? null, max: repsLimit } });
        return;
      case "duration":
        setPad({ key, request: { title: "Durée", unit: "s", decimals: 0, current: activeDraft.durationSeconds ?? 0, previous: previousSet?.durationSeconds ?? null, max: durationLimit } });
        return;
      default: {
        const unreachable: never = key;
        return unreachable;
      }
    }
  };

  const confirmPad = (value: number): void => {
    if (pad === null) return;
    switch (pad.key) {
      case "load":
        updateDraft({ loadGrams: massToGrams(value, unit) });
        break;
      case "reps":
        updateDraft({ reps: Math.round(value) });
        break;
      case "duration":
        updateDraft({ durationSeconds: Math.round(value) });
        break;
      default: {
        const unreachable: never = pad.key;
        return unreachable;
      }
    }
    setPad(null);
  };

  const startSet = (): void => {
    setActiveSet({ key: draftKey, startedAt: Date.now() });
    void impactAsync(ImpactFeedbackStyle.Light);
  };

  const adjustRest = (delta: number): void => {
    if (lastSet === null || progress.restSeconds === null) return;
    const planned = progress.restSeconds;
    const setId = lastSet.set.id;
    setRestAdjust((current) => {
      const previous = current.setId === setId ? current.delta : 0;
      return { setId, delta: Math.max(restElapsed + 1 - planned, previous + delta) };
    });
  };

  const commitUndoable = (summary: string, mutations: readonly Mutation[], message: string): boolean => {
    try {
      undoableWrite({ summary, mutations, message, ...placement });
      return true;
    } catch (error) {
      if (error instanceof InvalidSetError) {
        notify({ text: "Valeurs invalides", ...placement });
        return false;
      }
      throw error;
    }
  };

  const validate = (): void => {
    if (display === undefined) return;
    if (finished) {
      leaving.current = true;
      write("Séance terminée", finishMutations(data, environment.now()));
      router.replace({ pathname: "/session/[id]/review", params: { id: sessionId } });
      return;
    }
    if (editing !== null) {
      const before = display.sets[editing.index];
      if (before === undefined) return;
      try {
        write(`${display.exercise.name}, série ${editing.index + 1} : ${correctionSummary(before, editing.draft, unit)}`, correctSetMutations(data, editing.setId, editing.draft));
      } catch (error) {
        if (error instanceof InvalidSetError) {
          notify({ text: "Valeurs invalides", ...placement });
          return;
        }
        throw error;
      }
      setEditing(null);
      void impactAsync(ImpactFeedbackStyle.Medium);
      notify({ text: `Série ${editing.index + 1} corrigée · ${setText(editing.draft, unit)}`, ...placement });
      return;
    }
    const completedAt = environment.now();
    const restBeforeSeconds = active !== null && lastSet !== null ? Math.round((active.startedAt - lastSet.set.completedAt) / 1000) : null;
    const summary = setText(draft, unit);
    const lastOfExercise = display.sets.length + 1 >= display.target.sets;
    const message = !lastOfExercise ? `Série ${setIndex + 1} enregistrée · ${summary}` : pendingOthers(display.entry.id) === 0 ? "Séance terminée" : `${display.exercise.name} terminé · ${summary}`;
    const mutations = logSetMutations(data, { entryId: display.entry.id, setId: environment.newId(), values: draft, restBeforeSeconds, completedAt });
    if (!commitUndoable(`${display.exercise.name}, série ${setIndex + 1} : ${summary}`, mutations, message)) return;
    setActiveSet(null);
    void impactAsync(ImpactFeedbackStyle.Medium);
    scrollRef.current?.scrollTo({ y: 0, animated: !reduceMotion });
  };

  const painTarget = (): PainTarget | null => {
    if (display === undefined) return null;
    const name = lowerFirst(display.exercise.name);
    if (editing !== null) return { phase: "during", strengthSetId: editing.setId, label: `Sur la série ${editing.index + 1}, en correction`, exerciseIndex: displayIndex };
    const resting = finished || band.kind === "running" || band.kind === "done";
    if (resting && lastSet !== null) {
      const owner = data.exercises[lastSet.exerciseIndex];
      if (owner !== undefined) {
        const index = owner.sets.findIndex((set) => set.id === lastSet.set.id);
        return { phase: "between", strengthSetId: lastSet.set.id, label: `Après la série ${index + 1} · ${lowerFirst(owner.exercise.name)}`, exerciseIndex: lastSet.exerciseIndex };
      }
    }
    return { phase: "during", strengthSetId: null, label: `Pendant la série ${setIndex + 1} · ${name}`, exerciseIndex: displayIndex };
  };

  const trackedNow = unique([...live.tracked, ...data.pains.filter((report) => isPainful(report.level)).map((report) => report.zone)]);
  const painOptions = (target: PainTarget | null): { readonly zones: PainZoneOption[]; readonly other: ZoneKey[] } => {
    const owner = target === null ? undefined : data.exercises[target.exerciseIndex];
    const source = owner === undefined || owner.zones.length === 0 ? sports.strength.painZones : owner.zones;
    const specific = source.filter((zone) => !trackedNow.includes(zone)).slice(0, 3);
    const listed = [...trackedNow, ...specific];
    const other = unique([...sports.strength.painZones, ...zoneKeys]).filter((zone) => !listed.includes(zone));
    return { zones: [...trackedNow.map((zone) => ({ zone, tracked: true })), ...specific.map((zone) => ({ zone, tracked: false }))], other };
  };
  const options = painOptions(pain.target);

  const openPain = (): void => setPain({ ...closedPain, open: true, target: painTarget() });

  const savePain = (): void => {
    const target = pain.target;
    if (target === null || pain.pending.size === 0) return;
    const at = environment.now();
    write(
      `Douleur : ${[...pain.pending.keys()].map(zoneLabel).join(", ")}`,
      painReportMutations({
        newId: environment.newId,
        sessionId,
        phase: target.phase,
        strengthSetId: target.strengthSetId,
        sessionItemId: null,
        occurredAt: at,
        timeZone: data.session.timeZone,
        levels: pain.pending,
        tracked: live.tracked,
      }).mutations,
    );
    const stopped = [...pain.pending.entries()].filter(([, level]) => level === "stop").map(([zone]) => zoneLabel(zone));
    if (stopped.length > 0 && !finished) {
      setPain({ ...pain, step: "stop", stopTitle: `${stopped.join(", ")} : arrêt` });
      return;
    }
    setPain((current) => ({ ...current, open: false }));
    notify({ text: `Douleur enregistrée · ${lowerFirst(target.label.split(" · ")[0] ?? "")}`, ...placement });
  };

  const stopExercise = (): void => {
    setPain((current) => ({ ...current, open: false }));
    if (display === undefined || display.entry.status !== "pending") return;
    const interrupt = editing === null && (active !== null || hasPendingDuringPain(data));
    const restBeforeSeconds = active !== null && lastSet !== null ? Math.round((active.startedAt - lastSet.set.completedAt) / 1000) : null;
    const mutations = stopEntryMutations(
      data,
      display.entry.id,
      interrupt ? { setId: environment.newId(), loadGrams: display.exercise.measure === "load_reps" ? draft.loadGrams : null, restBeforeSeconds, completedAt: environment.now() } : null,
    );
    const message = pendingOthers(display.entry.id) === 0 ? "Séance terminée · douleur enregistrée" : `${display.exercise.name} arrêté · douleur enregistrée`;
    if (!commitUndoable(`${display.exercise.name} arrêté`, mutations, message)) return;
    setEditing(null);
    setActiveSet(null);
  };

  const closeSheet = (): void => setSheet((current) => ({ ...current, open: false }));

  const skip = (): void => {
    closeSheet();
    if (display === undefined) return;
    commitUndoable(`${display.exercise.name} passé`, skipEntryMutations(data, display.entry.id), `${display.exercise.name} passé`);
    setEditing(null);
  };

  const postpone = (): void => {
    closeSheet();
    if (display === undefined) return;
    commitUndoable(`${display.exercise.name} à la fin`, postponeEntryMutations(data, display.entry.id), `${display.exercise.name} à la fin`);
    setEditing(null);
  };

  const replace = (chosen: Exercise): void => {
    closeSheet();
    if (display === undefined) return;
    commitUndoable(
      `${display.exercise.name} remplacé par ${chosen.name}`,
      replaceExerciseMutations(data, display.entry.id, chosen.id, environment.newId()),
      `${display.exercise.name} remplacé par ${lowerFirst(chosen.name)}`,
    );
    setEditing(null);
  };

  const add = (chosen: Exercise): void => {
    closeSheet();
    commitUndoable(`${chosen.name} ajouté`, addExerciseMutations(db(), data, chosen.id, environment.newId()), `${chosen.name} ajouté`);
    setEditing(null);
  };

  const bringForward = (target: WorkoutExercise): void => {
    commitUndoable(`${target.exercise.name} maintenant`, bringForwardMutations(data, target.entry.id), `${target.exercise.name} maintenant`);
    setEditing(null);
  };

  const leave = (): void => {
    closeSheet();
    if (router.canGoBack()) router.back();
    else router.replace("/");
  };

  const finishNow = (): void => {
    closeSheet();
    leaving.current = true;
    write("Séance terminée", finishMutations(data, environment.now()));
    router.replace({ pathname: "/session/[id]/review", params: { id: sessionId } });
  };

  const toggleTheme = (): void => {
    db()
      .update(settings)
      .set({ theme: palette === "sunlight" ? "dark" : "sunlight", updatedAt: environment.now() })
      .run();
  };

  const stopped = display === undefined ? [] : stoppedZones(display.zones, live.latestPains);
  const showWarning = !finished && editing === null && display !== undefined && stopped.length > 0 && display.sets.length === 0;
  const comparison =
    display === undefined || progression === null || base === null
      ? null
      : describeComparison({
          target: display,
          progression,
          previous: previousSet,
          draft: activeDraft,
          base,
          setIndex: editing?.index ?? setIndex,
          editing: editing !== null,
          unit,
          stepGrams,
          latestPains: live.latestPains,
        });
  const sessionLevels = new Map<ZoneKey, PainLevel>();
  for (const report of data.pains) sessionLevels.set(report.zone, report.level);
  const painLevel = worstLevel([...sessionLevels.values()]);
  const canValidate = finished || (display !== undefined && isDraftValid(display, activeDraft));
  const primaryMode = finished ? "finish" : editing !== null ? "edit" : "validate";
  const primaryLabel = finished ? "Faire le bilan de la séance" : editing !== null ? `Corriger la série ${editing.index + 1}` : `Valider la série ${setIndex + 1}`;

  return (
    <View style={[styles.root, { backgroundColor: colors.bg }]}>
      <RestBand band={band} />
      <ScrollView ref={scrollRef} contentContainerStyle={[styles.main, { paddingBottom: panelHeight + 32 }]} keyboardShouldPersistTaps="handled">
        {editing === null ? (
          <View style={styles.context}>
            <Text style={styles.where} tone="secondary" numberOfLines={1}>
              {sessionTitle}
            </Text>
            <Text style={styles.elapsed} tone="secondary" accessibilityLabel={`Durée ${formatLongClock(activeSeconds(data.session, now as EpochMs))}`}>
              {formatLongClock(activeSeconds(data.session, now as EpochMs))}
            </Text>
            <IconButton icon="sun" label="Mode plein soleil" pressed={palette === "sunlight"} onPress={toggleTheme} edge="end" />
          </View>
        ) : (
          <View style={styles.context}>
            <Text style={styles.editingLabel}>Correction de la série {editing.index + 1}</Text>
            <Pressable accessibilityRole="button" onPress={() => setEditing(null)} style={({ pressed }) => [styles.editingLeave, pressed && { backgroundColor: colors.surface }]}>
              <Text style={styles.editingLeaveLabel}>Quitter la correction</Text>
            </Pressable>
          </View>
        )}

        {display === undefined ? null : (
          <>
            <Steps exercises={data.exercises} currentIndex={progress.currentIndex} displayIndex={displayIndex} />
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`${display.exercise.name}, actions de l'exercice`}
              onPress={() => setSheet({ open: true, mode: "menu" })}
              style={({ pressed }) => [styles.titleButton, pressed && { backgroundColor: colors.surface }]}
            >
              <Text style={styles.title} numberOfLines={1} accessibilityRole="header">
                {display.exercise.name}
              </Text>
              <Icon name="expand" color={colors.text3} />
            </Pressable>
            {showWarning ? (
              <View accessibilityRole="alert" style={[styles.warning, { backgroundColor: colors.surface, borderColor: colors.stop }]}>
                <PainMark level="stop" />
                <Text style={styles.warningText} numberOfLines={1}>
                  {stopped.map(zoneLabel).join(", ")} : arrêt
                </Text>
                <Pressable accessibilityRole="button" onPress={() => setSheet({ open: true, mode: "replace" })} style={({ pressed }) => [styles.warningAction, pressed && { backgroundColor: colors.surfacePress }]}>
                  <Text style={styles.linkLabel}>Remplacer</Text>
                </Pressable>
              </View>
            ) : (
              <Text style={styles.target} tone="secondary">
                {targetText(display)} · repos {formatClock(display.target.restSeconds)}
                {display.target.rir === null ? "" : ` · RIR ${display.target.rir}`}
              </Text>
            )}
            <Track
              exercise={display}
              previous={live.previous.get(display.entry.id) ?? null}
              currentSetIndex={finished ? null : setIndex}
              editingSetId={editing?.setId ?? null}
              pains={data.pains}
              unit={unit}
              onEdit={(set) => {
                const index = display.sets.findIndex((candidate) => candidate.id === set.id);
                setEditing({ setId: set.id, index, draft: { loadGrams: set.loadGrams, reps: set.reps, durationSeconds: set.durationSeconds, rir: set.rir } });
              }}
            />
            {finished || comparison === null ? null : (
              <Readout
                target={display}
                draft={activeDraft}
                suggested={editing === null && suggested}
                unit={unit}
                stepGrams={stepGrams}
                comparison={comparison}
                onAdjust={adjust}
                onOpenPad={openPad}
                onRir={(rir) => updateDraft({ rir })}
              />
            )}
          </>
        )}
        {empty ? (
          <View style={styles.empty}>
            <Text style={styles.emptyTitle} accessibilityRole="header">
              Aucun exercice
            </Text>
            <Text tone="secondary">Choisis un premier exercice pour commencer la séance.</Text>
            <PrimaryButton label="Ajouter un exercice" icon={<Icon name="plus" color={colors.actInk} />} onPress={() => setSheet({ open: true, mode: "add" })} style={styles.emptyAction} />
            <LinkButton label="Autres actions" onPress={() => setSheet({ open: true, mode: "menu" })} style={styles.emptyMore} />
          </View>
        ) : finished ? (
          <View style={[styles.finished, { backgroundColor: colors.surface }]}>
            <Text style={styles.finishedTitle}>Séance terminée</Text>
            <Text tone="secondary">Séries enregistrées.</Text>
          </View>
        ) : (
          <UpNext exercises={data.exercises} fromIndex={displayIndex} latestPains={live.latestPains} onBringForward={bringForward} />
        )}
        {empty || editing !== null ? null : (
          <ControlButton label="Ajouter un exercice" icon={<Icon name="plus" size={18} color={colors.text} />} onPress={() => setSheet({ open: true, mode: "add" })} style={styles.addExercise} />
        )}
      </ScrollView>

      {empty ? null : (
        <View onLayout={(event) => setPanelHeight(event.nativeEvent.layout.height)} style={[styles.panel, { backgroundColor: colors.bg, borderTopColor: colors.line, paddingBottom: insets.bottom + 12 }]}>
          {band.kind === "running" ? (
            <View style={styles.strip}>
              <StripButton label="−15 s" accessibilityLabel="Raccourcir le repos de 15 secondes" onPress={() => adjustRest(-15)} flex={1} />
              <StripButton label="+15 s" accessibilityLabel="Allonger le repos de 15 secondes" onPress={() => adjustRest(15)} flex={1} />
              <StripButton label="Passer le repos" onPress={startSet} flex={1.4} />
            </View>
          ) : null}
          {band.kind === "done" ? (
            <View style={styles.strip}>
              <StripButton label={`Commencer la série ${setIndex + 1}`} onPress={startSet} flex={1} />
            </View>
          ) : null}
          <View style={styles.actions}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={painLevel === null ? "Douleur" : `Douleur, ${painLevel === "stop" ? "arrêt signalé" : "gêne signalée"}`}
              onPress={openPain}
              style={({ pressed }) => [styles.painButton, { backgroundColor: pressed ? colors.surfacePress : colors.surface, borderColor: colors.controlBorder }]}
            >
              <Text style={styles.painLabel}>Douleur</Text>
              {painLevel === null ? null : (
                <View style={styles.painIndicator}>
                  <PainMark level={painLevel} />
                </View>
              )}
            </Pressable>
            <ActionButton mode={primaryMode} label={primaryLabel} disabled={!canValidate} onPress={validate} />
          </View>
        </View>
      )}

      <PainSheet
        open={pain.open}
        step={pain.step}
        context={pain.target?.label ?? ""}
        zones={options.zones}
        otherZones={options.other}
        pending={pain.pending}
        stopTitle={pain.stopTitle}
        onChange={(zone, level) => {
          const next = new Map(pain.pending);
          if (level === null) next.delete(zone);
          else next.set(zone, level);
          setPain({ ...pain, pending: next });
        }}
        onSave={savePain}
        onClose={() => setPain((current) => ({ ...current, open: false }))}
        onStopExercise={stopExercise}
        onReplace={() => {
          setPain((current) => ({ ...current, open: false }));
          setSheet({ open: true, mode: "replace" });
        }}
      />
      <PadSheet request={pad?.request ?? null} onClose={() => setPad(null)} onConfirm={confirmPad} />
      <ExerciseSheet
        open={sheet.open}
        mode={sheet.mode}
        title={display?.exercise.name ?? sessionTitle}
        sessionTitle={sessionTitle}
        exerciseId={display?.exercise.id ?? null}
        canChange={!finished && display?.entry.status === "pending"}
        canPostpone={display !== undefined && pendingOthers(display.entry.id) > 0}
        onMode={(mode) => setSheet({ open: true, mode })}
        onSkip={skip}
        onPostpone={postpone}
        onReplace={replace}
        onAdd={add}
        onHistory={() => {
          closeSheet();
          if (display !== undefined) router.push({ pathname: "/journal/progress", params: { exercise: display.exercise.id } });
        }}
        onLeave={leave}
        onFinish={finishNow}
        onClose={closeSheet}
      />
    </View>
  );
}

interface StripButtonProps {
  readonly label: string;
  readonly accessibilityLabel?: string;
  readonly flex: number;
  readonly onPress: () => void;
}

function StripButton({ label, accessibilityLabel, flex, onPress }: StripButtonProps) {
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      onPress={onPress}
      style={({ pressed }) => [styles.stripButton, { flex, backgroundColor: pressed ? colors.surfacePress : colors.surface, borderColor: colors.controlBorder }]}
    >
      <Text variant="label">{label}</Text>
    </Pressable>
  );
}

interface ActionButtonProps {
  readonly mode: "validate" | "edit" | "finish";
  readonly label: string;
  readonly disabled: boolean;
  readonly onPress: () => void;
}

function ActionButton({ mode, label, disabled, onPress }: ActionButtonProps) {
  const { colors } = useTheme();
  const press = usePressScale(0.98);
  const editMode = mode === "edit";
  return (
    <Animated.View style={[styles.actionCell, { transform: [{ scale: press.scale }] }, disabled && styles.disabled]}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ disabled }}
        disabled={disabled}
        onPress={onPress}
        onPressIn={press.onPressIn}
        onPressOut={press.onPressOut}
        style={({ pressed }) => [
          styles.action,
          editMode
            ? { backgroundColor: pressed ? colors.surfacePress : colors.surface2, borderWidth: 2, borderColor: colors.text }
            : { backgroundColor: pressed ? colors.actPress : colors.actBg },
        ]}
      >
        <Icon name={editMode ? "edit" : "check"} color={editMode ? colors.text : colors.actInk} />
        <Text style={[styles.actionLabel, { color: editMode ? colors.text : colors.actInk }]} numberOfLines={1}>
          {label}
        </Text>
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  main: { paddingTop: 14, paddingHorizontal: layout.gutter },
  context: { flexDirection: "row", alignItems: "center", gap: 12, minHeight: 24 },
  where: { flex: 1, fontFamily: fonts.text600, fontSize: 15 },
  elapsed: { fontFamily: fonts.figure600, fontSize: 17, lineHeight: 19 },
  editingLabel: { flex: 1, fontFamily: fonts.text700, fontSize: 15 },
  editingLeave: { minHeight: 44, marginVertical: -10, marginRight: -10, paddingHorizontal: 10, borderRadius: radii.control, justifyContent: "center" },
  editingLeaveLabel: { fontFamily: fonts.text700, fontSize: 15, textDecorationLine: "underline" },
  titleButton: { marginTop: 10, marginHorizontal: -8, paddingVertical: 8, paddingHorizontal: 8, minHeight: 44, flexDirection: "row", alignItems: "center", gap: 6, borderRadius: radii.control },
  title: { flexShrink: 1, fontFamily: fonts.text700, fontSize: 26, lineHeight: 29, letterSpacing: -0.4 },
  target: { fontFamily: fonts.text400, fontSize: 15, lineHeight: 21 },
  warning: { height: 48, paddingLeft: 12, paddingRight: 2, borderRadius: radii.control, borderWidth: layout.borderControl, flexDirection: "row", alignItems: "center", gap: 8, marginBottom: -4 },
  warningText: { flex: 1, minWidth: 0, fontFamily: fonts.text600, fontSize: 15 },
  warningAction: { height: 44, paddingHorizontal: 12, borderRadius: 6, justifyContent: "center" },
  linkLabel: { fontFamily: fonts.text700, fontSize: 16, textDecorationLine: "underline" },
  finished: { marginTop: 24, padding: 18, borderRadius: radii.panel, gap: 6 },
  finishedTitle: { fontFamily: fonts.text700, fontSize: 22, lineHeight: 25 },
  empty: { marginTop: 32, gap: 8 },
  emptyTitle: { fontFamily: fonts.text700, fontSize: 26, lineHeight: 29, letterSpacing: -0.4 },
  emptyAction: { marginTop: 16 },
  emptyMore: { alignSelf: "center", marginTop: 4 },
  addExercise: { marginTop: 24, alignSelf: "flex-start" },
  panel: { position: "absolute", left: 0, right: 0, bottom: 0, borderTopWidth: 1, paddingTop: 10, paddingHorizontal: layout.gutter, gap: 10 },
  strip: { flexDirection: "row", gap: 6 },
  stripButton: { height: 48, borderRadius: radii.control, borderWidth: layout.borderControl, alignItems: "center", justifyContent: "center", paddingHorizontal: 6 },
  actions: { flexDirection: "row", gap: 10 },
  painButton: { width: 72, height: 64, borderRadius: radii.panel, borderWidth: layout.borderControl, alignItems: "center", justifyContent: "center" },
  painLabel: { fontFamily: fonts.text700, fontSize: 14 },
  painIndicator: { position: "absolute", top: 9, right: 9 },
  actionCell: { flex: 1 },
  action: { height: 64, borderRadius: radii.panel, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 10, paddingHorizontal: 12 },
  actionLabel: { fontFamily: fonts.text700, fontSize: 18, flexShrink: 1 },
  disabled: { opacity: 0.4 },
});
