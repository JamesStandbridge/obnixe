/**
 * Recorder state machine (`REC-004`). Times `t` are milliseconds since the recording's time origin, as in the raw journal;
 * the origin is the instant of `start`. `pause`, `resume` (from `paused`) and `lap` are the marks reported by the native module
 * in journal order, whatever their origin (screen, notification, Live Activity); the screen asks `transition` whether a mark
 * would be accepted before requesting it.
 */

export const pauseReminderMs = 600_000;
export const inactivityStopMs = 21_600_000;
export const discardUndoMs = 10_000;
export const shortActivityMovingMs = 30_000;
export const shortActivityDistanceMm = 50_000;

export type Motion = "moving" | "stopped";

export interface RecorderTimers {
  readonly pausedMs: number;
  readonly autoPausedMs: number;
}

interface ActiveFields extends RecorderTimers {
  readonly autoPause: boolean;
  readonly motion: Motion;
  /** Start of the current stretch without activity (manual pause or motion stopped), for the inactivity stop (`REC-021`). */
  readonly idleSince: number | null;
}

export interface PreparingState {
  readonly phase: "preparing";
  readonly autoPause: boolean;
}

export interface RecordingState extends ActiveFields {
  readonly phase: "recording";
}

export interface AutoPausedState extends ActiveFields {
  readonly phase: "auto_paused";
  readonly since: number;
}

export interface PausedState extends ActiveFields {
  readonly phase: "paused";
  readonly since: number;
  readonly reminded: boolean;
}

export type FinishReason = "user" | "storage_full" | "inactivity" | "interruption";

/** What the stop summary needs from the processed track to choose its main action (`REC-052`). */
export interface ActivityBrief {
  readonly movingMs: number;
  /** Null when no distance was measured: a stopwatch recording (`REC-060`) is judged on its time alone. */
  readonly distanceMm: number | null;
}

export interface FinishingState extends RecorderTimers {
  readonly phase: "finishing";
  readonly autoPause: boolean;
  /** `interruption` means the session row is still `interrupted`. */
  readonly reason: FinishReason;
  readonly endT: number;
  readonly brief: ActivityBrief | null;
}

export interface InterruptedState extends RecorderTimers {
  readonly phase: "interrupted";
  readonly autoPause: boolean;
  /** Last valid sample of the raw journal (`REC-081`). */
  readonly endT: number;
}

export interface SavedState {
  readonly phase: "saved";
}

export interface DiscardedState {
  readonly phase: "discarded";
}

export type RecorderState = PreparingState | RecordingState | AutoPausedState | PausedState | FinishingState | InterruptedState | SavedState | DiscardedState;

export type RecorderPhase = RecorderState["phase"];

type ActiveState = RecordingState | AutoPausedState | PausedState;

export type RecorderEvent =
  | { readonly type: "start" }
  | { readonly type: "pause"; readonly t: number }
  | { readonly type: "resume"; readonly t: number }
  | { readonly type: "lap"; readonly t: number }
  | { readonly type: "motion_stopped"; readonly t: number }
  | { readonly type: "motion_started"; readonly t: number }
  | { readonly type: "set_auto_pause"; readonly enabled: boolean; readonly t: number }
  | { readonly type: "stop"; readonly reason: "user" | "storage_full"; readonly t: number }
  | { readonly type: "summarized"; readonly endT: number; readonly brief: ActivityBrief }
  | { readonly type: "save" }
  | { readonly type: "discard" }
  | { readonly type: "interrupt"; readonly lastSampleT: number }
  | { readonly type: "tick"; readonly t: number };

export type RecorderEventType = RecorderEvent["type"];

export type RecorderCommit = "start" | "interrupt" | "resume" | "save" | "discard";

export type RecorderAlert = "lap" | "auto_pause" | "auto_resume";

/** Effects run by the mobile orchestration, in order; a failed effect cancels the ones after it. */
export type RecorderEffect =
  | { readonly kind: "start_tracker" }
  | { readonly kind: "stop_tracker" }
  | { readonly kind: "commit"; readonly commit: RecorderCommit }
  | { readonly kind: "summarize"; readonly endT: number }
  | { readonly kind: "haptic" }
  | { readonly kind: "alert"; readonly alert: RecorderAlert }
  | { readonly kind: "refresh_notification" }
  | { readonly kind: "pause_reminder" }
  | { readonly kind: "delete_journal"; readonly delayMs: number };

/** `invalid`: the event never applies to this phase; `out_of_order`: it is older than the open pause or the end of the track. */
export type RecorderRefusalReason = "invalid" | "out_of_order" | "summary_pending" | "stale_summary" | "already_interrupted";

export interface RecorderRefusal {
  readonly phase: RecorderPhase;
  readonly event: RecorderEventType;
  readonly reason: RecorderRefusalReason;
}

export type RecorderTransition =
  | { readonly ok: true; readonly state: RecorderState; readonly effects: readonly RecorderEffect[] }
  | { readonly ok: false; readonly refusal: RecorderRefusal };

export interface RecorderClock {
  readonly elapsedMs: number;
  /** Main chronometer: frozen during manual and automatic pauses (`REC-031` display semantics). */
  readonly timerMs: number;
}

const accept = (state: RecorderState, ...effects: RecorderEffect[]): RecorderTransition => ({ ok: true, state, effects });

const refuse = (state: RecorderState, event: RecorderEvent, reason: RecorderRefusalReason): RecorderTransition => ({ ok: false, refusal: { phase: state.phase, event: event.type, reason } });

const refresh: RecorderEffect = { kind: "refresh_notification" };

function fields(state: ActiveState): ActiveFields {
  return { autoPause: state.autoPause, motion: state.motion, idleSince: state.idleSince, pausedMs: state.pausedMs, autoPausedMs: state.autoPausedMs };
}

/** Timers with the open pause closed at `end`. */
function settle(state: ActiveState, end: number): RecorderTimers {
  switch (state.phase) {
    case "recording":
      return { pausedMs: state.pausedMs, autoPausedMs: state.autoPausedMs };
    case "auto_paused":
      return { pausedMs: state.pausedMs, autoPausedMs: state.autoPausedMs + Math.max(0, end - state.since) };
    case "paused":
      return { pausedMs: state.pausedMs + Math.max(0, end - state.since), autoPausedMs: state.autoPausedMs };
    default: {
      const unreachable: never = state;
      throw new Error(`Unhandled recorder state ${JSON.stringify(unreachable)}`);
    }
  }
}

const precedesPause = (state: ActiveState, t: number): boolean => state.phase !== "recording" && t < state.since;

/** Automatic pause holds exactly while it is enabled and the motion is stopped, so a later `motion_started` always ends it. */
function running(base: ActiveFields, t: number): RecordingState | AutoPausedState {
  return base.autoPause && base.motion === "stopped" ? { phase: "auto_paused", ...base, since: t } : { phase: "recording", ...base };
}

function restart(state: FinishingState | InterruptedState, event: RecorderEvent, t: number, commit: boolean): RecorderTransition {
  if (t < state.endT) return refuse(state, event, "out_of_order");
  const next: RecordingState = { phase: "recording", autoPause: state.autoPause, motion: "moving", idleSince: null, pausedMs: state.pausedMs + t - state.endT, autoPausedMs: state.autoPausedMs };
  return commit ? accept(next, { kind: "start_tracker" }, { kind: "commit", commit: "resume" }) : accept(next, { kind: "start_tracker" });
}

function finish(state: ActiveState, event: RecorderEvent, t: number, reason: FinishReason): RecorderTransition {
  if (precedesPause(state, t)) return refuse(state, event, "out_of_order");
  return accept({ phase: "finishing", autoPause: state.autoPause, ...settle(state, t), reason, endT: t, brief: null }, { kind: "stop_tracker" }, { kind: "summarize", endT: t });
}

function interrupt(state: ActiveState | FinishingState, lastSampleT: number): RecorderTransition {
  const timers = state.phase === "finishing" ? { pausedMs: state.pausedMs, autoPausedMs: state.autoPausedMs } : settle(state, lastSampleT);
  return accept({ phase: "interrupted", autoPause: state.autoPause, ...timers, endT: lastSampleT }, { kind: "commit", commit: "interrupt" });
}

function tick(state: ActiveState, event: RecorderEvent, t: number): RecorderTransition {
  if (state.idleSince !== null && t - state.idleSince >= inactivityStopMs) return finish(state, event, t, "inactivity");
  if (state.phase === "paused" && !state.reminded && t - state.since >= pauseReminderMs) return accept({ ...state, reminded: true }, { kind: "pause_reminder" });
  return accept(state);
}

function fromPreparing(state: PreparingState, event: RecorderEvent): RecorderTransition {
  switch (event.type) {
    case "start":
      return accept({ phase: "recording", autoPause: state.autoPause, motion: "moving", idleSince: null, pausedMs: 0, autoPausedMs: 0 }, { kind: "start_tracker" }, { kind: "commit", commit: "start" });
    case "set_auto_pause":
      return accept({ ...state, autoPause: event.enabled });
    case "tick":
      return accept(state);
    case "pause":
    case "resume":
    case "lap":
    case "motion_stopped":
    case "motion_started":
    case "stop":
    case "summarized":
    case "save":
    case "discard":
    case "interrupt":
      return refuse(state, event, "invalid");
    default: {
      const unreachable: never = event;
      throw new Error(`Unhandled recorder event ${JSON.stringify(unreachable)}`);
    }
  }
}

function fromRecording(state: RecordingState, event: RecorderEvent): RecorderTransition {
  switch (event.type) {
    case "pause":
      return accept({ phase: "paused", ...fields(state), idleSince: state.idleSince ?? event.t, since: event.t, reminded: false }, { kind: "haptic" }, refresh);
    case "lap":
      return accept(state, { kind: "alert", alert: "lap" });
    case "motion_stopped": {
      if (state.motion === "stopped") return accept(state);
      const stopped: ActiveFields = { ...fields(state), motion: "stopped", idleSince: event.t };
      return state.autoPause ? accept({ phase: "auto_paused", ...stopped, since: event.t }, { kind: "alert", alert: "auto_pause" }, refresh) : accept({ phase: "recording", ...stopped });
    }
    case "motion_started":
      return accept({ ...state, motion: "moving", idleSince: null });
    case "set_auto_pause": {
      const next = running({ ...fields(state), autoPause: event.enabled }, event.t);
      return next.phase === "auto_paused" ? accept(next, refresh) : accept(next);
    }
    case "stop":
      return finish(state, event, event.t, event.reason);
    case "interrupt":
      return interrupt(state, event.lastSampleT);
    case "tick":
      return tick(state, event, event.t);
    case "start":
    case "resume":
    case "summarized":
    case "save":
    case "discard":
      return refuse(state, event, "invalid");
    default: {
      const unreachable: never = event;
      throw new Error(`Unhandled recorder event ${JSON.stringify(unreachable)}`);
    }
  }
}

function fromAutoPaused(state: AutoPausedState, event: RecorderEvent): RecorderTransition {
  switch (event.type) {
    case "pause":
      if (precedesPause(state, event.t)) return refuse(state, event, "out_of_order");
      return accept({ phase: "paused", ...fields(state), ...settle(state, event.t), since: event.t, reminded: false }, { kind: "haptic" }, refresh);
    case "lap":
      return accept(state, { kind: "alert", alert: "lap" });
    case "motion_stopped":
      return accept(state);
    case "motion_started":
      if (precedesPause(state, event.t)) return refuse(state, event, "out_of_order");
      return accept({ phase: "recording", ...fields(state), ...settle(state, event.t), motion: "moving", idleSince: null }, { kind: "alert", alert: "auto_resume" }, refresh);
    case "set_auto_pause":
      if (event.enabled) return accept(state);
      if (precedesPause(state, event.t)) return refuse(state, event, "out_of_order");
      return accept({ phase: "recording", ...fields(state), ...settle(state, event.t), autoPause: false }, refresh);
    case "stop":
      return finish(state, event, event.t, event.reason);
    case "interrupt":
      return interrupt(state, event.lastSampleT);
    case "tick":
      return tick(state, event, event.t);
    case "start":
    case "resume":
    case "summarized":
    case "save":
    case "discard":
      return refuse(state, event, "invalid");
    default: {
      const unreachable: never = event;
      throw new Error(`Unhandled recorder event ${JSON.stringify(unreachable)}`);
    }
  }
}

function fromPaused(state: PausedState, event: RecorderEvent): RecorderTransition {
  switch (event.type) {
    case "resume": {
      if (precedesPause(state, event.t)) return refuse(state, event, "out_of_order");
      const idleSince = state.motion === "moving" ? null : state.idleSince;
      return accept(running({ ...fields(state), ...settle(state, event.t), idleSince }, event.t), refresh);
    }
    case "motion_stopped":
      return accept({ ...state, motion: "stopped" });
    case "motion_started":
      return accept({ ...state, motion: "moving" });
    case "set_auto_pause":
      return accept({ ...state, autoPause: event.enabled });
    case "stop":
      return finish(state, event, event.t, event.reason);
    case "interrupt":
      return interrupt(state, event.lastSampleT);
    case "tick":
      return tick(state, event, event.t);
    case "start":
    case "pause":
    case "lap":
    case "summarized":
    case "save":
    case "discard":
      return refuse(state, event, "invalid");
    default: {
      const unreachable: never = event;
      throw new Error(`Unhandled recorder event ${JSON.stringify(unreachable)}`);
    }
  }
}

function fromFinishing(state: FinishingState, event: RecorderEvent): RecorderTransition {
  switch (event.type) {
    case "resume":
      return restart(state, event, event.t, state.reason === "interruption");
    case "summarized":
      if (event.endT !== state.endT) return refuse(state, event, "stale_summary");
      return accept({ ...state, brief: event.brief });
    case "save":
      if (state.brief === null) return refuse(state, event, "summary_pending");
      return accept({ phase: "saved" }, { kind: "commit", commit: "save" }, { kind: "delete_journal", delayMs: 0 });
    case "discard":
      return accept({ phase: "discarded" }, { kind: "commit", commit: "discard" }, { kind: "delete_journal", delayMs: discardUndoMs });
    case "interrupt":
      if (state.reason === "interruption") return refuse(state, event, "already_interrupted");
      return interrupt(state, event.lastSampleT);
    case "tick":
      return accept(state);
    case "start":
    case "pause":
    case "lap":
    case "motion_stopped":
    case "motion_started":
    case "set_auto_pause":
    case "stop":
      return refuse(state, event, "invalid");
    default: {
      const unreachable: never = event;
      throw new Error(`Unhandled recorder event ${JSON.stringify(unreachable)}`);
    }
  }
}

function fromInterrupted(state: InterruptedState, event: RecorderEvent): RecorderTransition {
  switch (event.type) {
    case "resume":
      return restart(state, event, event.t, true);
    case "stop":
      return accept({ phase: "finishing", autoPause: state.autoPause, pausedMs: state.pausedMs, autoPausedMs: state.autoPausedMs, reason: "interruption", endT: state.endT, brief: null }, { kind: "summarize", endT: state.endT });
    case "tick":
      return accept(state);
    case "start":
    case "pause":
    case "lap":
    case "motion_stopped":
    case "motion_started":
    case "set_auto_pause":
    case "summarized":
    case "save":
    case "discard":
    case "interrupt":
      return refuse(state, event, "invalid");
    default: {
      const unreachable: never = event;
      throw new Error(`Unhandled recorder event ${JSON.stringify(unreachable)}`);
    }
  }
}

function fromTerminal(state: SavedState | DiscardedState, event: RecorderEvent): RecorderTransition {
  return event.type === "tick" ? accept(state) : refuse(state, event, "invalid");
}

/** Pure and total: every (state, event) pair yields either the next state with its effects or a typed refusal (`REC-004`). */
export function transition(state: RecorderState, event: RecorderEvent): RecorderTransition {
  switch (state.phase) {
    case "preparing":
      return fromPreparing(state, event);
    case "recording":
      return fromRecording(state, event);
    case "auto_paused":
      return fromAutoPaused(state, event);
    case "paused":
      return fromPaused(state, event);
    case "finishing":
      return fromFinishing(state, event);
    case "interrupted":
      return fromInterrupted(state, event);
    case "saved":
    case "discarded":
      return fromTerminal(state, event);
    default: {
      const unreachable: never = state;
      throw new Error(`Unhandled recorder state ${JSON.stringify(unreachable)}`);
    }
  }
}

/** `null` while nothing is timed: before `start` and once the session is saved or discarded. */
export function recorderClock(state: RecorderState, t: number): RecorderClock | null {
  switch (state.phase) {
    case "preparing":
    case "saved":
    case "discarded":
      return null;
    case "recording":
      return { elapsedMs: t, timerMs: t - state.pausedMs - state.autoPausedMs };
    case "auto_paused":
    case "paused":
      return { elapsedMs: t, timerMs: state.since - state.pausedMs - state.autoPausedMs };
    case "finishing":
    case "interrupted":
      return { elapsedMs: state.endT, timerMs: state.endT - state.pausedMs - state.autoPausedMs };
    default: {
      const unreachable: never = state;
      throw new Error(`Unhandled recorder state ${JSON.stringify(unreachable)}`);
    }
  }
}

/** The stop summary then makes *Supprimer* its main action (`REC-052`). */
export function isShortActivity(brief: ActivityBrief): boolean {
  return brief.movingMs < shortActivityMovingMs || (brief.distanceMm !== null && brief.distanceMm < shortActivityDistanceMm);
}
