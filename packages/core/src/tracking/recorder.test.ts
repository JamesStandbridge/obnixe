import { describe, expect, it } from "vitest";
import { discardUndoMs, inactivityStopMs, isShortActivity, pauseReminderMs, recorderClock, transition } from "./recorder.ts";
import type { RecorderEffect, RecorderEvent, RecorderEventType, RecorderPhase, RecorderRefusalReason, RecorderState } from "./recorder.ts";

function apply(state: RecorderState, event: RecorderEvent): RecorderState {
  const result = transition(state, event);
  if (!result.ok) throw new Error(`${result.refusal.event} refused in ${result.refusal.phase}: ${result.refusal.reason}`);
  return result.state;
}

function effectsOf(state: RecorderState, event: RecorderEvent): readonly RecorderEffect[] {
  const result = transition(state, event);
  if (!result.ok) throw new Error(`${result.refusal.event} refused in ${result.refusal.phase}: ${result.refusal.reason}`);
  return result.effects;
}

function run(state: RecorderState, events: readonly RecorderEvent[]): RecorderState {
  return events.reduce(apply, state);
}

function refusal(state: RecorderState, event: RecorderEvent): RecorderRefusalReason | null {
  const result = transition(state, event);
  return result.ok ? null : result.refusal.reason;
}

const preparing = (autoPause: boolean): RecorderState => ({ phase: "preparing", autoPause });
const started = (autoPause: boolean): RecorderState => apply(preparing(autoPause), { type: "start" });

const samples: Readonly<Record<RecorderPhase, readonly RecorderState[]>> = {
  preparing: [preparing(true), preparing(false)],
  recording: [started(true), started(false), run(started(false), [{ type: "motion_stopped", t: 1_000 }])],
  auto_paused: [run(started(true), [{ type: "motion_stopped", t: 1_000 }])],
  paused: [run(started(true), [{ type: "pause", t: 1_000 }]), run(started(false), [{ type: "pause", t: 1_000 }, { type: "tick", t: 1_000 + pauseReminderMs }])],
  finishing: [
    run(started(true), [{ type: "stop", t: 2_000, reason: "user" }]),
    run(started(true), [{ type: "stop", t: 2_000, reason: "user" }, { type: "summarized", endT: 2_000, brief: { movingMs: 2_000, distanceMm: 6_000 } }]),
    run(started(true), [{ type: "interrupt", lastSampleT: 2_000 }, { type: "stop", t: 9_000, reason: "user" }]),
  ],
  interrupted: [run(started(true), [{ type: "interrupt", lastSampleT: 2_000 }])],
  saved: [{ phase: "saved" }],
  discarded: [{ phase: "discarded" }],
};

const t = 5_000;
const events: Readonly<Record<RecorderEventType, RecorderEvent>> = {
  start: { type: "start" },
  pause: { type: "pause", t },
  resume: { type: "resume", t },
  lap: { type: "lap", t },
  motion_stopped: { type: "motion_stopped", t },
  motion_started: { type: "motion_started", t },
  set_auto_pause: { type: "set_auto_pause", enabled: false, t },
  stop: { type: "stop", reason: "user", t },
  summarized: { type: "summarized", endT: 2_000, brief: { movingMs: 2_000, distanceMm: 6_000 } },
  save: { type: "save" },
  discard: { type: "discard" },
  interrupt: { type: "interrupt", lastSampleT: t },
  tick: { type: "tick", t },
};

const phases = Object.keys(samples) as RecorderPhase[];
const eventTypes = Object.keys(events) as RecorderEventType[];

/** Phases where each event applies, from the transition table of the recording chapter. */
const accepted: Readonly<Record<RecorderEventType, readonly RecorderPhase[]>> = {
  start: ["preparing"],
  pause: ["recording", "auto_paused"],
  resume: ["paused", "finishing", "interrupted"],
  lap: ["recording", "auto_paused"],
  motion_stopped: ["recording", "auto_paused", "paused"],
  motion_started: ["recording", "auto_paused", "paused"],
  set_auto_pause: ["preparing", "recording", "auto_paused", "paused"],
  stop: ["recording", "auto_paused", "paused", "interrupted"],
  summarized: ["finishing"],
  save: ["finishing"],
  discard: ["finishing"],
  interrupt: ["recording", "auto_paused", "paused", "finishing"],
  tick: phases,
};

const committing = new Set(["start", "save", "discard", "interrupt"]);

describe("transition", () => {
  it("answers every state and event pair with a next state or a typed refusal", () => {
    for (const phase of phases) {
      for (const state of samples[phase]) {
        expect(state.phase).toBe(phase);
        for (const type of eventTypes) {
          const result = transition(state, events[type]);
          if (result.ok) {
            expect(accepted[type], `${type} in ${phase}`).toContain(phase);
            expect(phases).toContain(result.state.phase);
          } else {
            expect(result.refusal.phase).toBe(phase);
            expect(result.refusal.event).toBe(type);
            if (result.refusal.reason === "invalid") expect(accepted[type], `${type} in ${phase}`).not.toContain(phase);
          }
        }
      }
    }
  });

  it("accepts every pair of the transition table", () => {
    for (const type of eventTypes) {
      for (const phase of accepted[type]) {
        const outcomes = samples[phase].map((state) => refusal(state, events[type]));
        expect(outcomes.some((reason) => reason !== "invalid"), `${type} in ${phase}`).toBe(true);
      }
    }
  });

  it("commits only on start, save, discard and passages through interrupted (REC-005)", () => {
    for (const phase of phases) {
      for (const state of samples[phase]) {
        for (const type of eventTypes) {
          const result = transition(state, events[type]);
          if (!result.ok) continue;
          const commits = result.effects.filter((effect) => effect.kind === "commit");
          const throughInterrupted = phase === "interrupted" || (phase === "finishing" && state.phase === "finishing" && state.reason === "interruption");
          if (!committing.has(type) && !(type === "resume" && throughInterrupted)) expect(commits, `${type} in ${phase}`).toEqual([]);
        }
      }
    }
    const long = Array.from({ length: 200 }, (_, index): RecorderEvent[] => {
      const base = index * 60_000;
      return [
        { type: "lap", t: base + 1_000 },
        { type: "motion_stopped", t: base + 10_000 },
        { type: "motion_started", t: base + 20_000 },
        { type: "pause", t: base + 30_000 },
        { type: "tick", t: base + 40_000 },
        { type: "resume", t: base + 50_000 },
      ];
    }).flat();
    let state = started(true);
    for (const event of long) {
      const result = transition(state, event);
      if (!result.ok) throw new Error(result.refusal.reason);
      expect(result.effects.some((effect) => effect.kind === "commit")).toBe(false);
      state = result.state;
    }
  });

  it("starts the tracker before committing the session", () => {
    expect(effectsOf(preparing(true), { type: "start" })).toEqual([{ kind: "start_tracker" }, { kind: "commit", commit: "start" }]);
  });
});

describe("pauses", () => {
  it("freezes the main chronometer during manual and automatic pauses while elapsed time runs (REC-020, REC-031)", () => {
    const state = run(started(true), [
      { type: "motion_stopped", t: 60_000 },
      { type: "motion_started", t: 90_000 },
      { type: "pause", t: 120_000 },
    ]);
    expect(state.phase).toBe("paused");
    expect(recorderClock(state, 200_000)).toEqual({ elapsedMs: 200_000, timerMs: 90_000 });
    const resumed = apply(state, { type: "resume", t: 300_000 });
    expect(recorderClock(resumed, 400_000)).toEqual({ elapsedMs: 400_000, timerMs: 190_000 });
  });

  it("only changes the display when automatic pause is off", () => {
    const events: readonly RecorderEvent[] = [
      { type: "motion_stopped", t: 60_000 },
      { type: "motion_started", t: 90_000 },
    ];
    const without = run(started(false), events);
    expect(without.phase).toBe("recording");
    expect(recorderClock(without, 120_000)).toEqual({ elapsedMs: 120_000, timerMs: 120_000 });
    expect(effectsOf(started(false), { type: "motion_stopped", t: 60_000 })).toEqual([]);
    expect(effectsOf(started(true), { type: "motion_stopped", t: 60_000 })).toEqual([{ kind: "alert", alert: "auto_pause" }, { kind: "refresh_notification" }]);
    expect(effectsOf(run(started(true), [events[0] as RecorderEvent]), { type: "motion_started", t: 90_000 })).toEqual([{ kind: "alert", alert: "auto_resume" }, { kind: "refresh_notification" }]);
  });

  it("lets manual pause override automatic pause and confirms it by haptic and notification", () => {
    const autoPaused = run(started(true), [{ type: "motion_stopped", t: 10_000 }]);
    const result = transition(autoPaused, { type: "pause", t: 15_000 });
    expect(result).toMatchObject({ ok: true, state: { phase: "paused", since: 15_000, autoPausedMs: 5_000 }, effects: [{ kind: "haptic" }, { kind: "refresh_notification" }] });
    expect(refusal(apply(autoPaused, { type: "pause", t: 15_000 }), { type: "motion_started", t: 20_000 })).toBeNull();
  });

  it("resumes into automatic pause when the athlete is still stopped", () => {
    const state = run(started(true), [
      { type: "pause", t: 10_000 },
      { type: "motion_stopped", t: 12_000 },
      { type: "resume", t: 20_000 },
    ]);
    expect(state).toMatchObject({ phase: "auto_paused", since: 20_000, pausedMs: 10_000, idleSince: 10_000 });
    expect(run(state, [{ type: "motion_started", t: 25_000 }])).toMatchObject({ phase: "recording", autoPausedMs: 5_000, idleSince: null });
  });

  it("applies an automatic pause toggle during the activity at once", () => {
    const stopped = run(started(false), [{ type: "motion_stopped", t: 10_000 }]);
    const enabled = apply(stopped, { type: "set_auto_pause", enabled: true, t: 30_000 });
    expect(enabled).toMatchObject({ phase: "auto_paused", since: 30_000, autoPause: true });
    expect(apply(enabled, { type: "set_auto_pause", enabled: false, t: 40_000 })).toMatchObject({ phase: "recording", autoPause: false, autoPausedMs: 10_000 });
    expect(apply(preparing(true), { type: "set_auto_pause", enabled: false, t: 0 })).toEqual(preparing(false));
  });

  it("only takes laps while recording or automatically paused (REC-040)", () => {
    expect(effectsOf(started(true), { type: "lap", t: 1_000 })).toEqual([{ kind: "alert", alert: "lap" }]);
    expect(refusal(run(started(true), [{ type: "pause", t: 500 }]), { type: "lap", t: 1_000 })).toBe("invalid");
  });

  it("refuses marks older than the open pause", () => {
    const paused = run(started(true), [{ type: "pause", t: 10_000 }]);
    expect(refusal(paused, { type: "resume", t: 9_000 })).toBe("out_of_order");
    expect(refusal(paused, { type: "stop", t: 9_000, reason: "user" })).toBe("out_of_order");
    const autoPaused = run(started(true), [{ type: "motion_stopped", t: 10_000 }]);
    expect(refusal(autoPaused, { type: "motion_started", t: 9_000 })).toBe("out_of_order");
    expect(refusal(autoPaused, { type: "pause", t: 9_000 })).toBe("out_of_order");
  });
});

describe("long inactivity (REC-021)", () => {
  it("reminds once after 10 minutes of manual pause", () => {
    const paused = run(started(true), [{ type: "pause", t: 60_000 }]);
    expect(effectsOf(paused, { type: "tick", t: 60_000 + pauseReminderMs - 1 })).toEqual([]);
    const reminded = transition(paused, { type: "tick", t: 60_000 + pauseReminderMs });
    expect(reminded).toMatchObject({ ok: true, state: { reminded: true }, effects: [{ kind: "pause_reminder" }] });
    if (!reminded.ok) return;
    expect(effectsOf(reminded.state, { type: "tick", t: 60_000 + 2 * pauseReminderMs })).toEqual([]);
  });

  it("stops acquisition after 6 hours without activity, counting the stillness before the pause", () => {
    const paused = run(started(false), [
      { type: "motion_stopped", t: 60_000 },
      { type: "pause", t: 120_000 },
    ]);
    expect(transition(paused, { type: "tick", t: 60_000 + inactivityStopMs - 1 })).toMatchObject({ ok: true, state: { phase: "paused" } });
    const end = 60_000 + inactivityStopMs;
    const result = transition(paused, { type: "tick", t: end });
    expect(result).toEqual({
      ok: true,
      state: { phase: "finishing", autoPause: false, pausedMs: end - 120_000, autoPausedMs: 0, reason: "inactivity", endT: end, brief: null },
      effects: [{ kind: "stop_tracker" }, { kind: "summarize", endT: end }],
    });
  });

  it("also stops a stopped recording without automatic pause, and restarts the count on movement", () => {
    const stopped = run(started(false), [{ type: "motion_stopped", t: 0 }]);
    expect(transition(stopped, { type: "tick", t: inactivityStopMs })).toMatchObject({ ok: true, state: { phase: "finishing", reason: "inactivity" } });
    const moved = run(stopped, [{ type: "motion_started", t: 1_000 }]);
    expect(transition(moved, { type: "tick", t: inactivityStopMs })).toMatchObject({ ok: true, state: { phase: "recording" } });
  });

  it("does not count a pause with movement as inactivity once resumed", () => {
    const state = run(started(true), [
      { type: "pause", t: 0 },
      { type: "resume", t: 1_000 },
    ]);
    expect(state).toMatchObject({ phase: "recording", idleSince: null });
  });
});

describe("finishing", () => {
  const stopped = run(started(true), [{ type: "stop", t: 600_000, reason: "user" }]);
  const brief = { movingMs: 590_000, distanceMm: 1_800_000 };

  it("stops the tracker and summarizes up to the stop", () => {
    expect(effectsOf(started(true), { type: "stop", t: 600_000, reason: "storage_full" })).toEqual([{ kind: "stop_tracker" }, { kind: "summarize", endT: 600_000 }]);
    expect(recorderClock(stopped, 900_000)).toEqual({ elapsedMs: 600_000, timerMs: 600_000 });
  });

  it("saves only once the summary of the current stop is known", () => {
    expect(refusal(stopped, { type: "save" })).toBe("summary_pending");
    expect(refusal(stopped, { type: "summarized", endT: 500_000, brief })).toBe("stale_summary");
    const summarized = apply(stopped, { type: "summarized", endT: 600_000, brief });
    expect(transition(summarized, { type: "save" })).toEqual({ ok: true, state: { phase: "saved" }, effects: [{ kind: "commit", commit: "save" }, { kind: "delete_journal", delayMs: 0 }] });
  });

  it("discards with an undo window before the journal goes", () => {
    expect(transition(stopped, { type: "discard" })).toEqual({ ok: true, state: { phase: "discarded" }, effects: [{ kind: "commit", commit: "discard" }, { kind: "delete_journal", delayMs: discardUndoMs }] });
  });

  it("turns the stopped interval into a manual pause on resume", () => {
    const result = transition(stopped, { type: "resume", t: 660_000 });
    expect(result).toMatchObject({ ok: true, state: { phase: "recording", pausedMs: 60_000, motion: "moving" }, effects: [{ kind: "start_tracker" }] });
    if (!result.ok) return;
    expect(recorderClock(result.state, 700_000)).toEqual({ elapsedMs: 700_000, timerMs: 640_000 });
    expect(refusal(stopped, { type: "resume", t: 500_000 })).toBe("out_of_order");
  });

  it("flags short activities (REC-052)", () => {
    expect(isShortActivity({ movingMs: 29_999, distanceMm: 1_000_000 })).toBe(true);
    expect(isShortActivity({ movingMs: 600_000, distanceMm: 49_999 })).toBe(true);
    expect(isShortActivity({ movingMs: 30_000, distanceMm: 50_000 })).toBe(false);
  });
});

describe("interruption", () => {
  const interrupted = run(started(true), [
    { type: "pause", t: 100_000 },
    { type: "interrupt", lastSampleT: 160_000 },
  ]);

  it("commits the interruption at the last sample, closing the open pause there", () => {
    expect(effectsOf(started(true), { type: "interrupt", lastSampleT: 0 })).toEqual([{ kind: "commit", commit: "interrupt" }]);
    expect(interrupted).toEqual({ phase: "interrupted", autoPause: true, pausedMs: 60_000, autoPausedMs: 0, endT: 160_000 });
    expect(recorderClock(interrupted, 1_000_000)).toEqual({ elapsedMs: 160_000, timerMs: 100_000 });
  });

  it("counts the gap as a pause on resume", () => {
    const result = transition(interrupted, { type: "resume", t: 400_000 });
    expect(result).toMatchObject({ ok: true, state: { phase: "recording", pausedMs: 300_000 }, effects: [{ kind: "start_tracker" }, { kind: "commit", commit: "resume" }] });
  });

  it("summarizes up to the last sample on stop and resumes the session row from there", () => {
    const result = transition(interrupted, { type: "stop", t: 900_000, reason: "user" });
    expect(result).toMatchObject({ ok: true, state: { phase: "finishing", reason: "interruption", endT: 160_000 }, effects: [{ kind: "summarize", endT: 160_000 }] });
    if (!result.ok) return;
    expect(effectsOf(result.state, { type: "resume", t: 900_000 })).toEqual([{ kind: "start_tracker" }, { kind: "commit", commit: "resume" }]);
    expect(refusal(result.state, { type: "interrupt", lastSampleT: 160_000 })).toBe("already_interrupted");
  });

  it("interrupts a stop summary left open when the app died", () => {
    const stopped = run(started(true), [{ type: "stop", t: 50_000, reason: "user" }]);
    expect(apply(stopped, { type: "interrupt", lastSampleT: 49_000 })).toEqual({ phase: "interrupted", autoPause: true, pausedMs: 0, autoPausedMs: 0, endT: 49_000 });
  });
});
