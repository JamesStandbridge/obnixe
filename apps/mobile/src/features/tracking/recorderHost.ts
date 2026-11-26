import { eq } from "drizzle-orm";
import {
  AlertMonitor,
  LiveSegmentWatch,
  LiveTracker,
  OpenSessionExistsError,
  activePrivacyMask,
  discardUndoMs,
  encodeTrack,
  heartRateZoneOf,
  heartRateZones,
  liveSegmentTargets,
  maxHeartRateOf,
  openLiveRecording,
  planInterruption,
  planRecordingDiscard,
  planRecordingResume,
  planRecordingSave,
  planRecordingStart,
  processTrack,
  profileOfSession,
  readJournal,
  readSettings,
  recorderClock,
  recordingLapSource,
  recordingSettingsOf,
  recordingStartMutations,
  signalLevelOf,
  storeDerivation,
  transition,
  WorkoutRunner,
  zoneProposalFor,
} from "@obnixe/core";
import type {
  ActivityPain,
  AlertGoal,
  AutoLap,
  BatteryAlertLevel,
  ElevationPoint,
  Fix,
  HeartRateZoneBounds,
  LiveLap,
  LiveSignal,
  LiveSnapshot,
  Mutation,
  ProcessedTrack,
  RecorderClock,
  RecorderCommit,
  RecorderEffect,
  RecorderEvent,
  RecorderRefusal,
  RecorderState,
  RecordingAlertEvent,
  RecordingStartPlan,
  RecordingStartRequest,
  ResolvedProfile,
  Sample,
  Track,
  TrackerMark,
  WorkoutView,
  ZoneProposal,
} from "@obnixe/core";
import { programSlot, session } from "@obnixe/schema";
import type { EpochMs, Id, RecordingSettings, WorkoutPlan, ZoneKey } from "@obnixe/schema";
import { db, environment } from "@/data/database";
import { LiveTrack } from "@/features/maps/liveTrack";
import type { LiveMapFeed } from "@/features/maps/liveTrack";
import { alertNotice } from "@/features/recording/alerts";
import type { AlertNotice } from "@/features/recording/alerts";
import { slotTarget } from "@/features/recording/target";
import { feedOf, journalTrackOf } from "@/features/tracking/journalFeed";
import type { FeedItem } from "@/features/tracking/journalFeed";
import { notificationOf, timerBaseOf } from "@/features/tracking/notification";
import { availableBytes, deleteJournal, journalUri, readJournalFile, writeTrack } from "@/features/tracking/trackStore";
import { formatNumber } from "@/format/numbers";
import type { SampleBatch, TrackerIssue, TrackerIssueKind, TrackerMarkEvent, TrackerModule, TrackerPower, TrackerReplay } from "../../../modules/obnixe-tracker";

/** The native tracker calls the host relies on; the tests pass a fake. */
export type TrackerPort = Pick<TrackerModule, "status" | "start" | "stop" | "mark" | "setPower" | "setNotification" | "prepare" | "cancelPreparation" | "addListener">;

/** Journaled commits as the user, with undo; the app passes `write` and `undo` of `@/data/write`. */
export interface RecorderWriter {
  readonly write: (summary: string, mutations: readonly Mutation[]) => Id;
  readonly undo: (changesetId: Id, summary: string) => void;
}

export interface RecorderFeedback {
  readonly haptic: () => void;
  /** `REC-075`: the vibration of the alert, and its brief sound when the sport asks for it; already filtered by the sport's settings. */
  readonly alert: (event: RecordingAlertEvent, sound: boolean) => void;
  /** `REC-022`: the local notification after 10 minutes of manual pause. */
  readonly pauseReminder: () => void;
  readonly clearPauseReminder: () => void;
  readonly report: (error: unknown) => void;
}

export interface RecorderHostOptions {
  readonly tracker: TrackerPort | null;
  readonly writer: RecorderWriter;
  readonly feedback: RecorderFeedback;
}

/** Below this free space the start is refused, the native module stopping itself at the same threshold (recovery table). */
export const storageFloorBytes = 10 * 1024 * 1024;
/** `NRG-001`: saver offered below 15 %, critical forced below 5 %. */
export const batteryThresholds = { saver: 0.15, critical: 0.05 } as const;
export const notificationIntervalMs = 5000;
export const publishIntervalMs = 1000;
/** How long the notification says the latest alert instead of the main metric. */
export const alertNotificationMs = 10_000;

export interface RecordingStart {
  readonly request: RecordingStartRequest;
  /** `REC-010`: the preparation screen may change the automatic pause for this activity only. */
  readonly autoPause: boolean;
  readonly power: TrackerPower;
  readonly replay: TrackerReplay | null;
}

/** The latest alert of a recording; `id` grows with each one so the screen shows each once. */
export interface LiveAlert {
  readonly id: number;
  readonly at: EpochMs;
  readonly event: RecordingAlertEvent;
  readonly notice: AlertNotice;
}

export interface StopSummary {
  readonly endT: number;
  readonly track: Track;
  readonly processed: ProcessedTrack;
}

export interface RecordingView {
  readonly sessionId: Id;
  readonly recordingId: Id;
  readonly profile: ResolvedProfile;
  readonly settings: RecordingSettings;
  readonly startedAt: EpochMs;
  readonly state: RecorderState;
  readonly clock: RecorderClock | null;
  /** `PRF-041`: the chronometer animates from this instant without React renders; null while frozen. */
  readonly timerBaseAt: EpochMs | null;
  readonly live: LiveSnapshot;
  /** Finished laps, oldest first; the current one is `live.lap`. */
  readonly laps: readonly LiveLap[];
  /** `UX-002`: altitude along the counted distance. */
  readonly elevation: readonly ElevationPoint[];
  /** `WKT-004`: the course of the guided workout, null for a free recording. */
  readonly workout: WorkoutView | null;
  readonly alert: LiveAlert | null;
  /** `INT-020`: the pains signalled so far, saved with the activity. */
  readonly pains: readonly ActivityPain[];
  readonly issues: readonly TrackerIssueKind[];
  readonly power: TrackerPower;
  readonly saverOffered: boolean;
  readonly summary: StopSummary | null;
  readonly busy: boolean;
}

export type RecorderView =
  | { readonly kind: "idle" }
  | { readonly kind: "preparing"; readonly signal: LiveSignal }
  | { readonly kind: "recording"; readonly recording: RecordingView };

export type RecorderFailure =
  | { readonly kind: "unsupported" }
  | { readonly kind: "busy" }
  | { readonly kind: "no_recording" }
  | { readonly kind: "refused"; readonly refusal: RecorderRefusal }
  | { readonly kind: "open_session"; readonly sessionId: Id }
  | { readonly kind: "storage_full" }
  | { readonly kind: "location_denied" }
  | { readonly kind: "failed"; readonly error: Error };

export type RecorderOutcome<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly failure: RecorderFailure };

export interface SavedRecording {
  readonly sessionId: Id;
  readonly changesetId: Id;
  /** `PRV-014`: a recurring start or finish without a zone, offered once. */
  readonly zoneProposal: ZoneProposal | null;
}

export interface DiscardedRecording {
  readonly sessionId: Id;
  readonly undoUntil: EpochMs;
}

interface Active {
  readonly sessionId: Id;
  readonly recordingId: Id;
  readonly profile: ResolvedProfile;
  readonly settings: RecordingSettings;
  readonly heartRate: readonly HeartRateZoneBounds[] | null;
  readonly workout: WorkoutPlan | null;
  readonly live: LiveTracker;
  readonly map: LiveTrack;
  readonly monitor: AlertMonitor;
  /** `SEG-004`: the known segments of the sport, followed on the live track. */
  readonly segments: LiveSegmentWatch;
  readonly runner: WorkoutRunner | null;
  readonly replay: TrackerReplay | null;
  readonly pains: ActivityPain[];
  alert: LiveAlert | null;
  plan: RecordingStartPlan | null;
  startedAt: EpochMs;
  state: RecorderState;
  /** Last journal batch applied, and whether its mark was. */
  sequence: number;
  markApplied: boolean;
  lastT: number;
  started: boolean;
  issues: Set<TrackerIssueKind>;
  power: TrackerPower;
  /** `NRG-001`: the saver mode is offered once per recording; choosing a mode or dismissing answers it. */
  saverOffer: "none" | "offered" | "answered";
  summary: StopSummary | null;
  /** The stop summary state a discard undo returns to. */
  restorable: RecorderState | null;
  saved: SavedRecording | null;
}

interface PendingDiscard {
  readonly active: Active;
  readonly restored: RecorderState;
  readonly changesetId: Id;
  readonly summary: string;
  timer: ReturnType<typeof setTimeout> | null;
}

type Inbound = { readonly kind: "samples"; readonly batch: SampleBatch } | { readonly kind: "mark"; readonly mark: TrackerMarkEvent } | { readonly kind: "issue"; readonly issue: TrackerIssue };

type Mode = "live" | "replay";

const idleView: RecorderView = { kind: "idle" };

const commitSummaries: Readonly<Record<Exclude<RecorderCommit, "save" | "discard">, string>> = {
  start: "Sortie démarrée",
  interrupt: "Sortie interrompue",
  resume: "Sortie reprise",
};

function isActivePhase(state: RecorderState): boolean {
  return state.phase === "recording" || state.phase === "auto_paused" || state.phase === "paused";
}

function autoLapOf(active: Pick<Active, "settings" | "workout">): AutoLap {
  return active.workout === null ? active.settings.autoLap : null;
}

function codeOf(error: unknown): string | null {
  return error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : null;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function batteryAlertOf(level: number): BatteryAlertLevel | null {
  if (level < batteryThresholds.critical) return "critical";
  return level < batteryThresholds.saver ? "low" : null;
}

function goalOf(slotId: Id | null): AlertGoal | null {
  if (slotId === null) return null;
  const slot = db().select({ targetValues: programSlot.targetValues, targetDurationSeconds: programSlot.targetDurationSeconds }).from(programSlot).where(eq(programSlot.id, slotId)).get();
  return slot === undefined ? null : slotTarget(slot);
}

const failed = <T>(failure: RecorderFailure): RecorderOutcome<T> => ({ ok: false, failure });
const succeeded = <T>(value: T): RecorderOutcome<T> => ({ ok: true, value });

/**
 * Drives one recording at a time from the native tracker (`REC-004`): feeds the journal to the live tracker and the recorder
 * state machine in journal order, runs the recorder's effects one after the other, persists through the journaled data
 * layer, and publishes a view at most once per second (`PRF-041`).
 */
export class RecorderHost {
  private readonly listeners = new Set<() => void>();
  private active: Active | null = null;
  private preparing: LiveSignal | null = null;
  private discarded: PendingDiscard | null = null;
  private busy = false;
  private view: RecorderView = idleView;
  private publishedAt = Number.NEGATIVE_INFINITY;
  private pendingPublish: ReturnType<typeof setTimeout> | null = null;
  private ticker: ReturnType<typeof setInterval> | null = null;
  private ticks = 0;
  private effects: Promise<void> = Promise.resolve();
  private inbox: Promise<void> = Promise.resolve();
  private buffered: Inbound[] | null = null;
  private readonly subscriptions: readonly { readonly remove: () => void }[];

  constructor(private readonly options: RecorderHostOptions) {
    const tracker = options.tracker;
    this.subscriptions =
      tracker === null
        ? []
        : [
            tracker.addListener("onSamples", (batch) => this.receive({ kind: "samples", batch })),
            tracker.addListener("onMark", (mark) => this.receive({ kind: "mark", mark })),
            tracker.addListener("onIssue", (issue) => this.receive({ kind: "issue", issue })),
            tracker.addListener("onWarmupFix", (fix) => this.warmup(fix)),
          ];
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly getView = (): RecorderView => this.view;

  /** The live map of the current recording (`GPS-071`), null when nothing records. */
  mapFeed(): LiveMapFeed | null {
    return this.active?.map ?? null;
  }

  dispose(): void {
    for (const subscription of this.subscriptions) subscription.remove();
    this.stopTicker();
    if (this.pendingPublish !== null) clearTimeout(this.pendingPublish);
    this.active?.map.dispose();
    if (this.discarded?.timer != null) clearTimeout(this.discarded.timer);
  }

  /** `REC-012`: warms the receiver up while the preparation screen is visible. */
  async prepare(): Promise<RecorderOutcome<void>> {
    const tracker = this.options.tracker;
    if (tracker === null) return failed({ kind: "unsupported" });
    if (this.active !== null) return failed({ kind: "busy" });
    this.preparing = { level: "none", accuracy: null };
    this.publish(true);
    try {
      await tracker.prepare();
      return succeeded(undefined);
    } catch (error) {
      this.preparing = null;
      this.publish(true);
      return failed(this.failureOf(error));
    }
  }

  /** `NRG-002`: leaving the preparation screen without starting stops the receiver. */
  cancelPreparation(): void {
    if (this.preparing === null) return;
    this.preparing = null;
    this.options.tracker?.cancelPreparation();
    this.publish(true);
  }

  /** `REC-003`, `INT-002`: opens the session once the tracker runs, from the instant its journal starts. */
  async start(start: RecordingStart): Promise<RecorderOutcome<Id>> {
    const tracker = this.options.tracker;
    if (tracker === null) return failed({ kind: "unsupported" });
    if (this.busy || this.active !== null) return failed({ kind: "busy" });
    this.busy = true;
    try {
      if ((await availableBytes()) < storageFloorBytes) return failed({ kind: "storage_full" });
      let plan: RecordingStartPlan;
      try {
        plan = planRecordingStart(db(), environment, start.request);
      } catch (error) {
        if (error instanceof OpenSessionExistsError) return failed({ kind: "open_session", sessionId: error.sessionId });
        throw error;
      }
      const settings: RecordingSettings = { ...plan.settings, autoPause: start.autoPause };
      this.preparing = null;
      const active = this.activate(
        { sessionId: plan.sessionId, recordingId: plan.recordingId, profile: plan.profile, settings, workout: start.request.workout, replay: start.replay, power: start.power, startedAt: environment.now() },
        goalOf(start.request.slot?.slotId ?? null),
      );
      active.plan = { ...plan, settings };
      try {
        await this.dispatch({ type: "start" }, "live");
      } catch (error) {
        await this.abandonStart(active);
        return failed(this.failureOf(error));
      }
      return succeeded(plan.sessionId);
    } finally {
      this.busy = false;
      this.publish(true);
    }
  }

  pause(): RecorderOutcome<void> {
    return this.requestMark("pause");
  }

  lap(): RecorderOutcome<void> {
    return this.requestMark("lap");
  }

  /** Resumes a manual pause through the journal, or restarts from the stop summary or an interruption (`REC-081`). */
  async resume(): Promise<RecorderOutcome<void>> {
    const active = this.active;
    if (active === null) return failed({ kind: "no_recording" });
    if (active.state.phase === "paused") return this.requestMark("resume");
    const outcome = await this.command(active, { type: "resume", t: this.trackTime(active) });
    if (outcome.ok) active.summary = null;
    return outcome;
  }

  setAutoPause(enabled: boolean): RecorderOutcome<void> {
    const active = this.active;
    if (active === null) return failed({ kind: "no_recording" });
    const result = transition(active.state, { type: "set_auto_pause", enabled, t: this.trackTime(active) });
    if (!result.ok) return failed({ kind: "refused", refusal: result.refusal });
    void this.dispatch({ type: "set_auto_pause", enabled, t: this.trackTime(active) }, "live").catch(this.options.feedback.report);
    return succeeded(undefined);
  }

  /** *Arrêter* during the activity, or *Terminer* an interrupted one: the summary follows once the journal is processed. */
  async stop(): Promise<RecorderOutcome<void>> {
    const active = this.active;
    if (active === null) return failed({ kind: "no_recording" });
    return this.command(active, { type: "stop", reason: "user", t: this.trackTime(active) });
  }

  /** `DAT-020`, `INT-030`: track file, then the « Sortie de 12,3 km » commit, then the derived rows; the journal goes last. */
  async save(): Promise<RecorderOutcome<SavedRecording>> {
    const active = this.active;
    if (active === null) return failed({ kind: "no_recording" });
    active.saved = null;
    const outcome = await this.command(active, { type: "save" });
    if (!outcome.ok) return outcome;
    const saved = active.saved;
    this.finish(active);
    return saved === null ? failed({ kind: "no_recording" }) : succeeded(saved);
  }

  /** Deletes the open session; `undoDiscard` restores it for 10 s, then the journal is deleted. */
  async discard(): Promise<RecorderOutcome<DiscardedRecording>> {
    const active = this.active;
    if (active === null) return failed({ kind: "no_recording" });
    active.restorable = active.state;
    const outcome = await this.command(active, { type: "discard" });
    if (!outcome.ok) return outcome;
    return succeeded({ sessionId: active.sessionId, undoUntil: (environment.now() + discardUndoMs) as EpochMs });
  }

  undoDiscard(): RecorderOutcome<void> {
    const pending = this.discarded;
    if (pending === null) return failed({ kind: "no_recording" });
    if (pending.timer !== null) clearTimeout(pending.timer);
    this.discarded = null;
    try {
      this.options.writer.undo(pending.changesetId, pending.summary);
    } catch (error) {
      void deleteJournal(pending.active.sessionId).catch(this.options.feedback.report);
      return failed(this.failureOf(error));
    }
    pending.active.state = pending.restored;
    this.active = pending.active;
    this.syncTicker();
    this.publish(true);
    return succeeded(undefined);
  }

  setPower(power: TrackerPower): void {
    const active = this.active;
    if (active === null || active.power === power) return;
    active.power = power;
    if (active.saverOffer === "offered") active.saverOffer = "answered";
    if (active.started && isActivePhase(active.state)) this.options.tracker?.setPower(power);
    this.publish(true);
  }

  /** `NRG-001`: below 15 % the screen offers the saver mode, below 5 % the critical mode is forced. */
  setBatteryLevel(level: number): void {
    const active = this.active;
    if (active === null || !isActivePhase(active.state) || level < 0) return;
    const alert = batteryAlertOf(level);
    if (alert !== null) this.signal(active, active.monitor.battery(alert));
    if (level < batteryThresholds.critical) {
      this.setPower("critical");
      return;
    }
    if (level < batteryThresholds.saver && active.power === "normal" && active.saverOffer === "none") {
      active.saverOffer = "offered";
      this.publish(true);
    }
  }

  /** `INT-020`: a pain signalled during the activity, saved with it as reported at this instant. */
  reportPain(zone: ZoneKey, level: ActivityPain["level"]): RecorderOutcome<void> {
    const active = this.active;
    if (active === null || !(isActivePhase(active.state) || active.state.phase === "finishing")) return failed({ kind: "no_recording" });
    active.pains.push({ zone, level, occurredAt: environment.now() });
    this.publish(true);
    return succeeded(undefined);
  }

  dismissSaverOffer(): void {
    const active = this.active;
    if (active?.saverOffer !== "offered") return;
    active.saverOffer = "answered";
    this.publish(true);
  }

  /**
   * Launch recovery (`REC-081`, `PLT-010`): rebuilds the recorder from the raw journal of the open session; when the native
   * tracker no longer records it, the session becomes `interrupted` at its last journaled instant.
   */
  async recover(): Promise<void> {
    if (this.active !== null) return;
    const open = openLiveRecording(db());
    if (open === null) return;
    const profile = profileOfSession(open.session);
    const settings: RecordingSettings = { ...recordingSettingsOf(db(), profile), autoPause: open.recording.autoPause };
    const active = this.activate(
      { sessionId: open.session.id, recordingId: open.recording.id, profile, settings, workout: open.recording.workout, replay: null, power: "normal", startedAt: open.session.startedAt },
      goalOf(open.session.slotId),
    );
    active.started = true;
    this.buffered = [];
    try {
      const bytes = await readJournalFile(active.sessionId);
      const contents = bytes === null ? null : readJournal(bytes);
      if (contents?.header !== null && contents?.header !== undefined) active.startedAt = contents.header.startedAt;
      this.apply(active, feedOf(contents?.samples ?? [], contents?.marks ?? []), "replay");
      if (active.state.phase === "preparing") await this.dispatch({ type: "start" }, "replay");
      active.sequence = contents?.lastSequence ?? -1;
      active.markApplied = true;
      const status = this.options.tracker?.status() ?? null;
      const recording = status !== null && status.state === "recording" && status.sessionId === active.sessionId;
      if (!recording && (isActivePhase(active.state) || active.state.phase === "finishing")) await this.dispatch({ type: "interrupt", lastSampleT: active.lastT }, "live");
      else this.observe(active);
    } finally {
      const pending = this.buffered;
      this.buffered = null;
      for (const event of pending) this.receive(event);
      this.syncTicker();
      this.publish(true);
    }
  }

  private requestMark(kind: "pause" | "resume" | "lap"): RecorderOutcome<void> {
    const active = this.active;
    const tracker = this.options.tracker;
    if (active === null || tracker === null) return failed({ kind: "no_recording" });
    const result = transition(active.state, { type: kind, t: this.trackTime(active) });
    if (!result.ok) return failed({ kind: "refused", refusal: result.refusal });
    tracker.mark(kind);
    return succeeded(undefined);
  }

  /** A user command: refused while another runs; its state change is rolled back when one of its effects fails. */
  private async command(active: Active, event: RecorderEvent): Promise<RecorderOutcome<void>> {
    if (this.busy) return failed({ kind: "busy" });
    const result = transition(active.state, event);
    if (!result.ok) return failed({ kind: "refused", refusal: result.refusal });
    this.busy = true;
    const previous = active.state;
    try {
      await this.dispatch(event, "live");
      return succeeded(undefined);
    } catch (error) {
      if (this.active === active) active.state = previous;
      return failed(this.failureOf(error));
    } finally {
      this.busy = false;
      this.syncTicker();
      this.publish(true);
    }
  }

  /** A guided workout replaces the automatic laps and the pace and heart-rate spans with its steps and their targets. */
  private activate(fields: Pick<Active, "sessionId" | "recordingId" | "profile" | "settings" | "workout" | "replay" | "power" | "startedAt">, goal: AlertGoal | null): Active {
    const physiology = readSettings(db());
    const maximum = maxHeartRateOf(physiology, fields.startedAt);
    const heartRate = maximum === null ? null : heartRateZones(maximum);
    const { workout } = fields;
    const autoLap = autoLapOf(fields);
    const alerts = workout === null ? fields.settings.alerts : { ...fields.settings.alerts, paceRange: null, heartRateRange: null };
    const active: Active = {
      ...fields,
      heartRate,
      live: new LiveTracker(fields.profile, autoLap),
      map: new LiveTrack(),
      monitor: new AlertMonitor({ splitMeters: autoLap === null ? fields.profile.splitMeters : null, settings: alerts, heartRateZones: heartRate, goal }),
      runner: workout === null ? null : new WorkoutRunner(workout, { heartRateZones: heartRate }),
      segments: new LiveSegmentWatch(liveSegmentTargets(db(), fields.profile.sport)),
      pains: [],
      alert: null,
      plan: null,
      state: { phase: "preparing", autoPause: fields.settings.autoPause },
      sequence: -1,
      markApplied: true,
      lastT: 0,
      started: false,
      issues: new Set(),
      saverOffer: "none",
      summary: null,
      restorable: null,
      saved: null,
    };
    this.active = active;
    return active;
  }

  private trackTime(active: Active): number {
    return Math.max(active.lastT, environment.now() - active.startedAt);
  }

  /**
   * Applies the event, then runs its effects after the ones already queued, or at once for an event raised by a running
   * effect; replayed events have no effect.
   */
  private dispatch(event: RecorderEvent, mode: Mode, fromEffect = false): Promise<void> {
    const active = this.active;
    if (active === null) return Promise.resolve();
    const result = transition(active.state, event);
    if (!result.ok) return Promise.resolve();
    const previous = active.state;
    active.state = result.state;
    if (previous.phase === "paused" && result.state.phase !== "paused") this.options.feedback.clearPauseReminder();
    if (mode === "replay") return Promise.resolve();
    this.syncTicker();
    if (previous.phase !== result.state.phase) this.publish(true);
    if (fromEffect) return this.run(active, result.effects);
    const run = this.effects.then(() => this.run(active, result.effects));
    this.effects = run.catch(() => undefined);
    return run;
  }

  private async run(active: Active, effects: readonly RecorderEffect[]): Promise<void> {
    for (const effect of effects) await this.execute(active, effect);
  }

  private async execute(active: Active, effect: RecorderEffect): Promise<void> {
    switch (effect.kind) {
      case "start_tracker":
        return this.startTracker(active);
      case "stop_tracker":
        return this.stopTracker();
      case "commit":
        return this.commit(active, effect.commit);
      case "summarize":
        return this.summarize(active, effect.endT);
      case "haptic":
        this.options.feedback.haptic();
        return;
      case "alert":
        if (effect.alert === "lap" && active.runner !== null) return;
        this.signal(active, active.monitor.recorder(effect.alert, effect.alert === "lap" ? (active.live.laps.at(-1) ?? null) : null));
        return;
      case "refresh_notification":
        this.refreshNotification(active);
        return;
      case "pause_reminder":
        this.options.feedback.pauseReminder();
        return;
      case "delete_journal":
        this.scheduleJournalDeletion(active, effect.delayMs);
        return;
      default: {
        const unreachable: never = effect;
        throw new Error(`Unhandled recorder effect ${JSON.stringify(unreachable)}`);
      }
    }
  }

  private async startTracker(active: Active): Promise<void> {
    const tracker = this.options.tracker;
    if (tracker === null) throw new Error("No tracker");
    const create = !active.started;
    const started = await tracker.start({
      sessionId: active.sessionId,
      journalPath: journalUri(active.sessionId),
      journal: create ? "create" : "continue",
      power: active.power,
      sensors: { barometer: true, pedometer: active.profile.cadence === "steps", heartRateDevice: active.settings.heartRateDevice?.id ?? null },
      batchIntervalMs: 1000,
      backgroundBatchIntervalMs: active.workout === null ? 5000 : 1000,
      notification: notificationOf(active.profile, active.state, active.live.snapshot(active.lastT), active.startedAt, null),
      replay: create ? active.replay : null,
    });
    active.started = true;
    active.startedAt = started.startedAt;
  }

  private async stopTracker(): Promise<void> {
    try {
      await this.options.tracker?.stop();
    } catch (error) {
      if (codeOf(error) !== "ERR_TRACKER_NOT_RECORDING") throw error;
    }
  }

  private async commit(active: Active, kind: RecorderCommit): Promise<void> {
    switch (kind) {
      case "start": {
        const plan = active.plan;
        if (plan === null) throw new Error("Start without a plan");
        const header = journalTrackOf(await readJournalFile(active.sessionId), active.startedAt).header;
        this.options.writer.write(commitSummaries.start, recordingStartMutations(plan, { startedAt: active.startedAt, device: header?.device ?? "" }));
        active.plan = null;
        return;
      }
      case "interrupt": {
        const row = db().select({ status: session.status }).from(session).where(eq(session.id, active.sessionId)).get();
        if (row?.status !== "in_progress") return;
        this.options.writer.write(commitSummaries.interrupt, planInterruption(db(), active.sessionId, (active.startedAt + active.lastT) as EpochMs));
        return;
      }
      case "resume":
        this.options.writer.write(commitSummaries.resume, planRecordingResume(db(), active.sessionId, environment.now()));
        return;
      case "save":
        active.saved = await this.persistSave(active);
        return;
      case "discard": {
        const restored = active.restorable;
        if (restored === null) throw new Error("Discard outside a discard command");
        const summary = "Sortie supprimée";
        const changesetId = this.options.writer.write(summary, planRecordingDiscard(db(), active.sessionId));
        this.active = null;
        this.stopTicker();
        this.options.feedback.clearPauseReminder();
        this.discarded = { active, restored, changesetId, summary, timer: null };
        return;
      }
      default: {
        const unreachable: never = kind;
        throw new Error(`Unhandled recorder commit ${String(unreachable)}`);
      }
    }
  }

  private async persistSave(active: Active): Promise<SavedRecording> {
    const summary = active.summary;
    if (summary === null) throw new Error("Save before the summary");
    const stored = await writeTrack(active.recordingId, encodeTrack(summary.track));
    const kilometers = summary.processed.summary.distanceMm / 1_000_000;
    const changesetId = this.options.writer.write(
      `Sortie de ${formatNumber(kilometers)} km`,
      planRecordingSave(db(), environment, { sessionId: active.sessionId, track: summary.track, processed: summary.processed, stored, pains: active.pains }),
    );
    storeDerivation(db(), active.sessionId, summary.track, summary.processed, activePrivacyMask(db()));
    return { sessionId: active.sessionId, changesetId, zoneProposal: zoneProposalFor(db(), active.sessionId) };
  }

  private async summarize(active: Active, endT: number): Promise<void> {
    const { track } = journalTrackOf(await readJournalFile(active.sessionId), active.startedAt);
    const processed = processTrack(track, active.profile, { laps: recordingLapSource(track, active.profile, autoLapOf(active), active.workout), trim: { startMs: 0, endMs: null } });
    active.summary = { endT, track, processed };
    this.publish(true);
    await this.dispatch({ type: "summarized", endT, brief: { movingMs: processed.summary.movingMs, distanceMm: processed.summary.distanceMm } }, "live", true);
  }

  private scheduleJournalDeletion(active: Active, delayMs: number): void {
    const remove = (): void => {
      void deleteJournal(active.sessionId).catch(this.options.feedback.report);
    };
    if (delayMs === 0) {
      remove();
      return;
    }
    const pending = this.discarded;
    if (pending === null || pending.active !== active) return;
    pending.timer = setTimeout(() => {
      if (this.discarded === pending) this.discarded = null;
      active.map.dispose();
      remove();
    }, delayMs);
  }

  private finish(active: Active): void {
    if (this.active !== active) return;
    this.active = null;
    active.map.dispose();
    this.stopTicker();
    this.options.feedback.clearPauseReminder();
    this.publish(true);
  }

  private async abandonStart(active: Active): Promise<void> {
    if (active.started) {
      await this.stopTracker().catch(this.options.feedback.report);
      await deleteJournal(active.sessionId).catch(this.options.feedback.report);
    }
    if (this.active === active) this.active = null;
    active.map.dispose();
    this.stopTicker();
  }

  private failureOf(error: unknown): RecorderFailure {
    if (codeOf(error) === "ERR_TRACKER_LOCATION_PERMISSION") return { kind: "location_denied" };
    return { kind: "failed", error: asError(error) };
  }

  private receive(event: Inbound): void {
    if (this.buffered !== null) {
      this.buffered.push(event);
      return;
    }
    this.inbox = this.inbox.then(() => this.handle(event)).catch(this.options.feedback.report);
  }

  private async handle(event: Inbound): Promise<void> {
    const active = this.active;
    if (active === null) return;
    switch (event.kind) {
      case "samples": {
        const { batch } = event;
        if (batch.sessionId !== active.sessionId || batch.sequence <= active.sequence) return;
        if (batch.sequence > active.sequence + 1) await this.catchUp(active);
        if (batch.sequence <= active.sequence) return;
        this.apply(
          active,
          batch.samples.map((sample): FeedItem => ({ kind: "sample", sample })),
          "live",
        );
        active.sequence = batch.sequence;
        active.markApplied = false;
        this.observe(active);
        return;
      }
      case "mark": {
        const { mark } = event;
        if (mark.sessionId !== active.sessionId || mark.sequence < active.sequence || (mark.sequence === active.sequence && active.markApplied)) return;
        if (mark.sequence > active.sequence + 1) await this.catchUp(active);
        if (mark.sequence < active.sequence || (mark.sequence === active.sequence && active.markApplied)) return;
        this.apply(active, [{ kind: "mark", mark: { kind: mark.kind, t: mark.t } }], "live");
        active.sequence = mark.sequence;
        active.markApplied = true;
        return;
      }
      case "issue":
        if (event.issue.sessionId === active.sessionId) await this.onIssue(active, event.issue.kind);
        return;
      default: {
        const unreachable: never = event;
        throw new Error(`Unhandled tracker event ${JSON.stringify(unreachable)}`);
      }
    }
  }

  /** A batch lost by the bridge: the journal on storage has it (`REC-080`). */
  private async catchUp(active: Active): Promise<void> {
    const bytes = await readJournalFile(active.sessionId);
    if (bytes === null) return;
    const contents = readJournal(bytes, { afterSequence: active.sequence });
    this.apply(active, feedOf(contents.samples, contents.marks), "live");
    if (contents.lastSequence !== null && contents.lastSequence > active.sequence) {
      active.sequence = contents.lastSequence;
      active.markApplied = true;
    }
  }

  private async onIssue(active: Active, kind: TrackerIssueKind): Promise<void> {
    active.issues.add(kind);
    if (kind === "heart_rate_lost") this.signal(active, active.monitor.heartRateSource(false));
    this.publish(true);
    if (kind === "storage_full") void this.dispatch({ type: "stop", reason: "storage_full", t: active.lastT }, "live").catch(this.options.feedback.report);
  }

  /**
   * Feeds journal items to the live tracker and the recorder. Live, only pause, resume and lap marks reach the recorder: the
   * start and stop marks echo what the host asked. A replay rebuilds the whole history, a later start being a resumption.
   */
  private apply(active: Active, items: readonly FeedItem[], mode: Mode): void {
    let position: Fix | null = null;
    for (const item of items) {
      if (item.kind === "sample") {
        position = item.sample.type === "fix" ? item.sample : position;
        this.applySample(active, item.sample, mode);
      } else {
        this.applyMark(active, item.mark, mode);
      }
    }
    for (const point of active.live.takeTrack()) {
      active.map.push({ latitude: point.latitude, longitude: point.longitude, stretch: point.dashed ? "interrupted" : "moving" });
      const passes = active.segments.push(point);
      if (mode === "live") this.signal(active, active.monitor.segments(passes));
    }
    if (position !== null) {
      active.map.locate({
        latitude: position.latitudeE7 / 1e7,
        longitude: position.longitudeE7 / 1e7,
        accuracyMeters: position.horizontalAccuracyDm === null ? null : position.horizontalAccuracyDm / 10,
        bearingDegrees: position.bearingCentiDeg === null ? null : position.bearingCentiDeg / 100,
      });
    }
  }

  private applySample(active: Active, sample: Sample, mode: Mode): void {
    active.lastT = Math.max(active.lastT, sample.t);
    if (sample.type === "fix") {
      active.issues.delete("permission_lost");
      active.issues.delete("provider_disabled");
    }
    if (sample.type === "heart_rate") {
      active.issues.delete("heart_rate_lost");
      if (mode === "live") this.signal(active, active.monitor.heartRateSource(true));
    }
    for (const event of active.live.push(sample)) {
      switch (event.type) {
        case "motion_started":
        case "motion_stopped":
          void this.dispatch({ type: event.type, t: event.t }, mode).catch(this.options.feedback.report);
          break;
        case "lap":
          void this.dispatch({ type: "lap", t: event.t }, mode).catch(this.options.feedback.report);
          break;
        case "off_route":
        case "back_on_route":
          break;
        default: {
          const unreachable: never = event;
          throw new Error(`Unhandled live event ${JSON.stringify(unreachable)}`);
        }
      }
    }
    if (sample.type === "fix" && active.runner !== null) {
      const events = active.runner.push(active.live.progress(sample.t));
      if (mode === "live") this.signal(active, events);
    }
  }

  private applyMark(active: Active, mark: TrackerMark, mode: Mode): void {
    active.lastT = Math.max(active.lastT, mark.t);
    active.live.mark(mark);
    if (active.runner !== null) {
      const events = active.runner.mark(mark);
      if (mode === "live") this.signal(active, events);
    }
    const report = this.options.feedback.report;
    switch (mark.kind) {
      case "pause":
      case "resume":
      case "lap":
        void this.dispatch({ type: mark.kind, t: mark.t }, mode).catch(report);
        return;
      case "start":
        if (mode === "replay") void this.dispatch(active.state.phase === "preparing" ? { type: "start" } : { type: "resume", t: mark.t }, mode).catch(report);
        return;
      case "stop":
        if (mode === "replay") void this.dispatch({ type: "stop", reason: "user", t: mark.t }, mode).catch(report);
        return;
      default: {
        const unreachable: never = mark.kind;
        throw new Error(`Unhandled mark ${String(unreachable)}`);
      }
    }
  }

  private warmup(fix: Fix): void {
    if (this.preparing === null) return;
    const accuracy = fix.horizontalAccuracyDm === null ? null : fix.horizontalAccuracyDm / 10;
    this.preparing = { level: signalLevelOf(accuracy), accuracy };
    this.publish(false);
  }

  /** `REC-075`: runs the alerts of the latest snapshot; the journal batches keep it going while the ticks sleep in the background. */
  private observe(active: Active): void {
    if (!isActivePhase(active.state)) return;
    this.signal(active, active.monitor.observe(active.live.snapshot(this.trackTime(active)), active.state.phase));
  }

  /** Signals the last of simultaneous alerts, a reached target coming after the split it ends on. */
  private signal(active: Active, events: readonly RecordingAlertEvent[]): void {
    const event = events.at(-1);
    if (event === undefined) return;
    active.alert = { id: (active.alert?.id ?? 0) + 1, at: environment.now(), event, notice: alertNotice(event, active.profile) };
    this.options.feedback.alert(event, active.settings.alerts.sound);
    this.refreshNotification(active);
    this.publish(true);
  }

  private refreshNotification(active: Active): void {
    if (!active.started || !isActivePhase(active.state)) return;
    const alert = active.alert !== null && environment.now() - active.alert.at < alertNotificationMs ? active.alert.notice : null;
    this.options.tracker?.setNotification(notificationOf(active.profile, active.state, active.live.snapshot(this.trackTime(active)), active.startedAt, alert));
  }

  private syncTicker(): void {
    const running = this.active !== null && isActivePhase(this.active.state);
    if (running && this.ticker === null) {
      this.ticks = 0;
      this.ticker = setInterval(() => this.tick(), publishIntervalMs);
    } else if (!running) {
      this.stopTicker();
    }
  }

  private stopTicker(): void {
    if (this.ticker === null) return;
    clearInterval(this.ticker);
    this.ticker = null;
  }

  private tick(): void {
    const active = this.active;
    if (active === null) return;
    this.ticks += 1;
    void this.dispatch({ type: "tick", t: this.trackTime(active) }, "live").catch(this.options.feedback.report);
    if (active.runner !== null && isActivePhase(active.state)) this.signal(active, active.runner.advance(this.trackTime(active)));
    this.observe(active);
    if (this.ticks % (notificationIntervalMs / publishIntervalMs) === 0) this.refreshNotification(active);
    this.publish(false);
  }

  /** At most one view per second; `now` publishes at once for a change the user caused. */
  private publish(now: boolean): void {
    const elapsed = environment.now() - this.publishedAt;
    if (!now && elapsed < publishIntervalMs) {
      this.pendingPublish ??= setTimeout(() => {
        this.pendingPublish = null;
        this.publish(true);
      }, publishIntervalMs - elapsed);
      return;
    }
    if (this.pendingPublish !== null) {
      clearTimeout(this.pendingPublish);
      this.pendingPublish = null;
    }
    this.publishedAt = environment.now();
    this.view = this.viewOf();
    for (const listener of this.listeners) listener();
  }

  private viewOf(): RecorderView {
    const active = this.active;
    if (active === null) return this.preparing === null ? idleView : { kind: "preparing", signal: this.preparing };
    const t = isActivePhase(active.state) ? this.trackTime(active) : active.lastT;
    const snapshot = active.live.snapshot(t);
    const heartRate = snapshot.metrics.heart_rate;
    const zone = heartRate === undefined || active.heartRate === null || !active.profile.metrics.includes("heart_rate_zone") ? null : heartRateZoneOf(heartRate, active.heartRate);
    return {
      kind: "recording",
      recording: {
        sessionId: active.sessionId,
        recordingId: active.recordingId,
        profile: active.profile,
        settings: active.settings,
        startedAt: active.startedAt,
        state: active.state,
        clock: recorderClock(active.state, t),
        timerBaseAt: timerBaseOf(active.state, active.startedAt),
        live: zone === null ? snapshot : { ...snapshot, metrics: { ...snapshot.metrics, heart_rate_zone: zone } },
        laps: active.live.laps,
        elevation: active.live.elevationProfile,
        workout: active.runner?.view(t) ?? null,
        alert: active.alert,
        pains: [...active.pains],
        issues: [...active.issues],
        power: active.power,
        saverOffered: active.saverOffer === "offered",
        summary: active.summary,
        busy: this.busy,
      },
    };
  }
}
