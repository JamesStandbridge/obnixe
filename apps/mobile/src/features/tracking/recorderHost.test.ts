import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { commit, defaultRecordingSettings, encodeJournalBatch, encodeJournalHeader, readJournal, recordingSettingsMutation, revert } from "@obnixe/core";
import type { Fix, JournalRecord, Mutation, Sample, TrackerMarkKind } from "@obnixe/core";
import { bestEffort, painReport, recording, session, settings } from "@obnixe/schema";
import type { EpochMs, Id, RecordingSettings } from "@obnixe/schema";
import { RecorderHost } from "@/features/tracking/recorderHost";
import type { RecorderFeedback, RecorderView, RecordingStart, RecordingView, TrackerPort } from "@/features/tracking/recorderHost";
import { journalUri, readTrackFile } from "@/features/tracking/trackStore";
import { db, environment } from "../../../test/mocks/database.ts";
import { Paths, storedFiles } from "../../../test/mocks/expoFileSystem.ts";
import type { TrackerEvents, TrackerIssueKind, TrackerNotification, TrackerPower, TrackerStartRequest, TrackerStatus } from "../../../modules/obnixe-tracker";

type Listeners = { [Name in keyof TrackerEvents]: Set<TrackerEvents[Name]> };

class TrackerError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

/** Writes real `.ojr` batches to the in-memory file system and echoes them like the native module. */
class FakeTracker implements TrackerPort {
  readonly listeners: Listeners = { onSamples: new Set(), onMark: new Set(), onIssue: new Set(), onHeartRateDevice: new Set(), onWarmupFix: new Set() };
  readonly notifications: TrackerNotification[] = [];
  readonly powers: TrackerPower[] = [];
  readonly requests: TrackerStartRequest[] = [];
  state: TrackerStatus = { state: "idle", sessionId: null };
  startedAt = 0 as EpochMs;
  sequence = 0;
  paused = false;
  stopped = false;
  lastT = 0;
  path = "";

  addListener<Name extends keyof TrackerEvents>(name: Name, listener: TrackerEvents[Name]): { remove: () => void } {
    const set = this.listeners[name] as Set<TrackerEvents[Name]>;
    set.add(listener);
    return { remove: () => set.delete(listener) };
  }

  status(): TrackerStatus {
    return this.state;
  }

  async prepare(): Promise<void> {}

  cancelPreparation(): void {}

  async start(request: TrackerStartRequest): Promise<{ startedAt: EpochMs; sources: { location: "replay"; barometer: false; pedometer: false; heartRate: false } }> {
    this.requests.push(request);
    this.path = request.journalPath;
    this.state = { state: "recording", sessionId: request.sessionId };
    if (request.journal === "create") {
      this.startedAt = Date.now() as EpochMs;
      this.sequence = 0;
      this.lastT = 0;
      storedFiles.set(this.path, encodeJournalHeader({ sessionId: request.sessionId as Id, startedAt: this.startedAt, monotonicOriginNs: 0n, platform: "android", device: "Pixel 9 Pro" }));
      this.write([], "start", 0);
    } else {
      const contents = readJournal(storedFiles.get(this.path) ?? new Uint8Array());
      this.startedAt = contents.header?.startedAt ?? this.startedAt;
      this.sequence = (contents.lastSequence ?? -1) + 1;
      if (!this.stopped) this.write([], "stop", this.lastT);
      this.write([], "start", this.now());
    }
    this.stopped = false;
    this.paused = false;
    return { startedAt: this.startedAt, sources: { location: "replay", barometer: false, pedometer: false, heartRate: false } };
  }

  mark(kind: "pause" | "resume" | "lap"): void {
    if ((kind === "resume") !== this.paused) return;
    if (kind !== "lap") this.paused = kind === "pause";
    this.write([], kind, this.now());
  }

  setPower(power: TrackerPower): void {
    this.powers.push(power);
  }

  setNotification(notification: TrackerNotification): void {
    this.notifications.push(notification);
  }

  async stop(): Promise<{ sessionId: string; endedAt: EpochMs; lastSequence: number }> {
    const sessionId = this.state.sessionId;
    if (sessionId === null) throw new TrackerError("ERR_TRACKER_NOT_RECORDING");
    this.write([], "stop", this.now());
    this.stopped = true;
    this.state = { state: "idle", sessionId: null };
    return { sessionId, endedAt: (this.startedAt + this.lastT) as EpochMs, lastSequence: this.sequence - 1 };
  }

  now(): number {
    return Math.max(this.lastT, Date.now() - this.startedAt);
  }

  /** Appends a batch; `silent` keeps it from the bridge, as a lost event. */
  write(samples: readonly Sample[], mark: TrackerMarkKind | null, markT: number, silent = false): void {
    const records: JournalRecord[] = [...samples];
    if (mark !== null) records.push({ type: "mark", kind: mark, t: markT });
    const sequence = this.sequence;
    this.sequence += 1;
    const current = storedFiles.get(this.path) ?? new Uint8Array();
    const batch = encodeJournalBatch(sequence, records);
    const next = new Uint8Array(current.length + batch.length);
    next.set(current);
    next.set(batch, current.length);
    storedFiles.set(this.path, next);
    for (const record of records) this.lastT = Math.max(this.lastT, record.t);
    if (silent) return;
    const sessionId = this.state.sessionId ?? "";
    if (samples.length > 0) for (const listener of this.listeners.onSamples) listener({ sessionId, sequence, samples });
    if (mark !== null) for (const listener of this.listeners.onMark) listener({ sessionId, sequence, kind: mark, t: markT });
  }

  issue(kind: TrackerIssueKind): void {
    for (const listener of this.listeners.onIssue) listener({ sessionId: this.state.sessionId ?? "", kind });
  }
}

const metersPerE7 = 111_195 / 1e7;

function fixAt(t: number, meters: number): Fix {
  return {
    type: "fix",
    t,
    fixAgeMs: 0,
    latitudeE7: 451_885_000 + Math.round(meters / metersPerE7),
    longitudeE7: 57_245_000,
    altitudeEllipsoidMm: 250_000,
    altitudeMslMm: null,
    horizontalAccuracyDm: 40,
    verticalAccuracyDm: null,
    speedCmS: 300,
    speedAccuracyCmS: 50,
    bearingCentiDeg: 0,
    bearingAccuracyCentiDeg: null,
    simulated: false,
  };
}

const writer = {
  write: (summary: string, mutations: readonly Mutation[]): Id => commit(db(), environment, { actor: { author: "user", connectionId: null }, summary, revertsId: null, mutations }),
  undo: (changesetId: Id, summary: string): void => {
    revert(db(), environment, { actor: { author: "user", connectionId: null }, changesetId, summary: `Annulation : ${summary}`, restoredVersionSummary: () => "" });
  },
};

const start: RecordingStart = { request: { sport: "run", values: {}, gearId: null, slot: null, timeZone: "Europe/Paris" }, autoPause: false, power: "normal", replay: null };

let tracker: FakeTracker;
let feedback: RecorderFeedback & { readonly calls: string[] };
let hosts: RecorderHost[];

function newHost(): RecorderHost {
  const host = new RecorderHost({ tracker, writer, feedback });
  hosts.push(host);
  return host;
}

async function settle(): Promise<void> {
  for (let round = 0; round < 5; round += 1) await new Promise<void>((resolve) => setImmediate(resolve));
}

/** Runs `seconds` of steady running at 3 m/s, one batch a second. */
async function run(seconds: number, fromMeters: number): Promise<number> {
  let meters = fromMeters;
  for (let second = 0; second < seconds; second += 1) {
    await vi.advanceTimersByTimeAsync(1000);
    meters += 3;
    tracker.write([fixAt(tracker.now(), meters)], null, 0);
  }
  await settle();
  return meters;
}

function recordingOf(host: RecorderHost): RecordingView {
  const view: RecorderView = host.getView();
  if (view.kind !== "recording") throw new Error(`No recording: ${view.kind}`);
  return view.recording;
}

const sessionRow = (id: Id) => db().select().from(session).where(eq(session.id, id)).get();
const recordingRow = (id: Id) => db().select().from(recording).where(eq(recording.sessionId, id)).get();

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"], now: Date.UTC(2026, 10, 20, 7, 0) });
  db()
    .insert(settings)
    .values({ singleton: 1, theme: "dark", massUnit: "kg", agentCanReadBody: false, agentCanWrite: false, agentCanReadPhotos: false, reminderWeekdays: 0, reminderMinutes: 1110, remindersExportedAt: null, agentChangesSeenAt: null, bridgeHost: null, updatedAt: environment.now() })
    .run();
  tracker = new FakeTracker();
  const calls: string[] = [];
  feedback = {
    calls,
    haptic: () => calls.push("haptic"),
    alert: (event, sound) => calls.push(`alert:${event.kind}${sound ? ":sound" : ""}`),
    pauseReminder: () => calls.push("pause_reminder"),
    clearPauseReminder: () => calls.push("clear_pause_reminder"),
    report: (error) => {
      throw error;
    },
  };
  hosts = [];
});

afterEach(() => {
  for (const host of hosts) host.dispose();
  vi.useRealTimers();
});

async function started(host: RecorderHost): Promise<Id> {
  const outcome = await host.start(start);
  if (!outcome.ok) throw new Error(`Start failed: ${outcome.failure.kind}`);
  await settle();
  return outcome.value;
}

describe("recording", () => {
  it("opens the session at the journal start, follows the native marks, then saves the track and the records (INT-030)", async () => {
    const host = newHost();
    const sessionId = await started(host);
    expect(sessionRow(sessionId)).toMatchObject({ status: "in_progress", startedAt: tracker.startedAt });
    expect(recordingRow(sessionId)).toMatchObject({ device: "Pixel 9 Pro", autoPause: false });
    let meters = await run(120, 0);
    expect(recordingOf(host).live.distanceMm).toBeGreaterThan(250_000);
    expect(host.pause()).toEqual({ ok: true, value: undefined });
    await settle();
    expect(recordingOf(host).state.phase).toBe("paused");
    expect(recordingOf(host).timerBaseAt).toBeNull();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(host.lap().ok).toBe(false);
    const resumed = await host.resume();
    expect(resumed.ok).toBe(true);
    await settle();
    expect(recordingOf(host).state.phase).toBe("recording");
    meters = await run(160, meters);
    expect(tracker.notifications.at(-1)?.title).toMatch(/^Course · \d,\d\d km$/);
    expect((await host.stop()).ok).toBe(true);
    await settle();
    const summary = recordingOf(host).summary;
    expect(summary?.processed.summary.distanceMm).toBeGreaterThan(600_000);
    expect(recordingOf(host).state).toMatchObject({ phase: "finishing", reason: "user" });
    const saved = await host.save();
    if (!saved.ok) throw new Error(`Save failed: ${saved.failure.kind}`);
    expect(saved.value.zoneProposal).toBeNull();
    const row = recordingRow(sessionId);
    expect(sessionRow(sessionId)?.status).toBe("completed");
    expect(row?.trackFile).toBe(`tracks/${row?.id ?? ""}.otrk`);
    expect(readTrackFile(row?.trackFile ?? "")?.length).toBe(row?.trackBytes);
    expect(storedFiles.has(journalUri(sessionId))).toBe(false);
    expect(db().select().from(bestEffort).where(eq(bestEffort.sessionId, sessionId)).all().map((effort) => effort.effort)).toContain("run:distance:400");
    expect(host.getView()).toEqual({ kind: "idle" });
    expect(feedback.calls).toContain("haptic");
    expect(meters).toBeGreaterThan(800);
  });

  it("refuses a second open session and a start without storage (REC-003)", async () => {
    const host = newHost();
    const sessionId = await started(host);
    expect(await host.start(start)).toEqual({ ok: false, failure: { kind: "busy" } });
    const outsider = new RecorderHost({ tracker: new FakeTracker(), writer, feedback });
    hosts.push(outsider);
    expect(await outsider.start(start)).toEqual({ ok: false, failure: { kind: "open_session", sessionId } });
    Paths.availableDiskSpace = 1024;
    try {
      const blocked = new RecorderHost({ tracker: new FakeTracker(), writer, feedback });
      hosts.push(blocked);
      expect(await blocked.start(start)).toEqual({ ok: false, failure: { kind: "storage_full" } });
    } finally {
      Paths.availableDiskSpace = 64 * 1024 * 1024 * 1024;
    }
  });

  it("stops the tracker and deletes the journal when the start commit fails", async () => {
    const failing = new RecorderHost({
      tracker,
      writer: {
        ...writer,
        write: () => {
          throw new Error("disk I/O");
        },
      },
      feedback,
    });
    hosts.push(failing);
    const outcome = await failing.start(start);
    expect(outcome.ok).toBe(false);
    expect(tracker.state.state).toBe("idle");
    expect([...storedFiles.keys()].filter((uri) => uri.endsWith(".ojr"))).toEqual([]);
    expect(failing.getView()).toEqual({ kind: "idle" });
  });

  it("discards for 10 s, during which the summary comes back", async () => {
    const host = newHost();
    const sessionId = await started(host);
    await run(20, 0);
    await host.stop();
    await settle();
    const discarded = await host.discard();
    expect(discarded.ok).toBe(true);
    expect(sessionRow(sessionId)).toBeUndefined();
    expect(host.getView()).toEqual({ kind: "idle" });
    expect(host.undoDiscard().ok).toBe(true);
    expect(sessionRow(sessionId)?.status).toBe("in_progress");
    expect(recordingOf(host).state.phase).toBe("finishing");
    await host.discard();
    await vi.advanceTimersByTimeAsync(10_000);
    await settle();
    expect(storedFiles.has(journalUri(sessionId))).toBe(false);
    expect(host.undoDiscard().ok).toBe(false);
  });

  it("stops by itself on a full storage, with the summary (recovery table)", async () => {
    const host = newHost();
    await started(host);
    await run(10, 0);
    tracker.issue("storage_full");
    await settle();
    expect(recordingOf(host).state).toMatchObject({ phase: "finishing", reason: "storage_full" });
    expect(recordingOf(host).issues).toContain("storage_full");
    expect(recordingOf(host).summary).not.toBeNull();
  });

  it("offers the saver mode under 15 % and forces the critical mode under 5 % (NRG-001)", async () => {
    const host = newHost();
    await started(host);
    host.setBatteryLevel(0.12);
    expect(recordingOf(host).saverOffered).toBe(true);
    host.dismissSaverOffer();
    host.setBatteryLevel(0.11);
    expect(recordingOf(host).saverOffered).toBe(false);
    host.setBatteryLevel(0.04);
    expect(recordingOf(host).power).toBe("critical");
    expect(tracker.powers).toEqual(["critical"]);
  });

  it("reads a batch the bridge lost back from the journal (REC-080)", async () => {
    const host = newHost();
    await started(host);
    await vi.advanceTimersByTimeAsync(1000);
    tracker.write([fixAt(tracker.now(), 3)], null, 0, true);
    tracker.write([], "lap", tracker.now(), true);
    await vi.advanceTimersByTimeAsync(1000);
    tracker.write([fixAt(tracker.now(), 6)], null, 0);
    await settle();
    await vi.advanceTimersByTimeAsync(1000);
    expect(feedback.calls).toContain("alert:lap");
    expect(recordingOf(host).live.lap.index).toBe(1);
    expect(recordingOf(host).laps.map((lap) => lap.index)).toEqual([0]);
  });
});

describe("alerts and sensors", () => {
  const runSettings = (changes: Partial<RecordingSettings>): void => {
    writer.write("Réglages", [recordingSettingsMutation(db(), "run", { ...defaultRecordingSettings({ autoPauseDefault: true }), ...changes })]);
  };

  it("announces each kilometer on the screen and in the notification, with the sport's sound choice (REC-075)", async () => {
    runSettings({ alerts: { disabled: [], sound: true, paceRange: null, heartRateRange: null } });
    const host = newHost();
    await started(host);
    await run(350, 0);
    expect(feedback.calls.filter((call) => call.startsWith("alert:"))).toEqual(["alert:split:sound"]);
    expect(recordingOf(host).alert).toMatchObject({ id: 1, event: { kind: "split", index: 1, meters: 1000 }, notice: { title: "Kilomètre 1" } });
    const announced = tracker.notifications.findIndex((notification) => notification.text.startsWith("Kilomètre 1 · "));
    expect(announced).toBeGreaterThan(0);
    expect(tracker.notifications.at(-1)?.text).toMatch(/^Allure /);
  });

  it("keeps quiet about the alerts the sport switched off", async () => {
    runSettings({ alerts: { disabled: ["split", "gps", "battery"], sound: false, paceRange: null, heartRateRange: null } });
    const host = newHost();
    await started(host);
    await run(350, 0);
    await vi.advanceTimersByTimeAsync(15_000);
    host.setBatteryLevel(0.1);
    expect(feedback.calls.filter((call) => call.startsWith("alert:"))).toEqual([]);
    expect(recordingOf(host).alert).toBeNull();
  });

  it("signals the GPS lost and back, a low battery once, and the heart-rate source lost and back", async () => {
    const host = newHost();
    await started(host);
    const meters = await run(20, 0);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(recordingOf(host).alert?.event).toEqual({ kind: "gps", change: "lost" });
    await run(3, meters);
    expect(recordingOf(host).alert?.event).toEqual({ kind: "gps", change: "back" });
    host.setBatteryLevel(0.12);
    host.setBatteryLevel(0.11);
    tracker.issue("heart_rate_lost");
    await settle();
    expect(recordingOf(host).issues).toContain("heart_rate_lost");
    tracker.write([{ type: "heart_rate", t: tracker.now(), bpm: 142, contact: "contact", rrInterval: null }], null, 0);
    await settle();
    expect(recordingOf(host).issues).not.toContain("heart_rate_lost");
    expect(feedback.calls.filter((call) => call.startsWith("alert:"))).toEqual(["alert:gps", "alert:gps", "alert:battery", "alert:sensor", "alert:sensor"]);
  });

  it("connects the paired heart-rate source by its address and names it on the recording (SPT-007)", async () => {
    runSettings({ heartRateDevice: { id: "C4:7D:2A:10:9E:01", name: "Venu 3S" } });
    const host = newHost();
    const sessionId = await started(host);
    expect(tracker.requests[0]?.sensors.heartRateDevice).toBe("C4:7D:2A:10:9E:01");
    expect(recordingRow(sessionId)?.heartRateDevice).toBe("Venu 3S");
    expect(recordingOf(host).settings.heartRateDevice).toEqual({ id: "C4:7D:2A:10:9E:01", name: "Venu 3S" });
  });

  it("saves the pains signalled during the activity at the instant they were (INT-020)", async () => {
    const host = newHost();
    const sessionId = await started(host);
    await run(30, 0);
    const signalledAt = Date.now();
    expect(host.reportPain("knee_right", "discomfort").ok).toBe(true);
    expect(recordingOf(host).pains).toEqual([{ zone: "knee_right", level: "discomfort", occurredAt: signalledAt }]);
    await run(10, 90);
    await host.stop();
    await settle();
    expect((await host.save()).ok).toBe(true);
    const reports = db().select().from(painReport).where(eq(painReport.sessionId, sessionId)).all();
    expect(reports.map((row) => ({ zone: row.zone, level: row.level, phase: row.phase, occurredAt: row.occurredAt }))).toEqual([
      { zone: "knee_right", level: "discomfort", phase: "during", occurredAt: signalledAt },
    ]);
    expect(host.reportPain("knee_right", "stop")).toEqual({ ok: false, failure: { kind: "no_recording" } });
  });
});

describe("launch recovery", () => {
  it("interrupts at the last journaled instant when the tracker died, then resumes with the gap as a pause (REC-081)", async () => {
    const first = newHost();
    const sessionId = await started(first);
    const meters = await run(30, 0);
    const lastT = tracker.lastT;
    first.dispose();
    tracker.state = { state: "idle", sessionId: null };
    await vi.advanceTimersByTimeAsync(600_000);
    const host = newHost();
    await host.recover();
    expect(sessionRow(sessionId)).toMatchObject({ status: "interrupted", endedAt: tracker.startedAt + lastT });
    expect(recordingOf(host).state).toMatchObject({ phase: "interrupted", endT: lastT });
    expect(recordingOf(host).live.distanceMm).toBeGreaterThan(50_000);
    expect((await host.resume()).ok).toBe(true);
    await settle();
    expect(tracker.requests.at(-1)?.journal).toBe("continue");
    expect(sessionRow(sessionId)).toMatchObject({ status: "in_progress", endedAt: null });
    expect(recordingOf(host).state.phase).toBe("recording");
    await run(10, meters);
    await host.stop();
    await settle();
    const processed = recordingOf(host).summary?.processed;
    expect(processed?.pauses.some((pause) => pause.endMs - pause.startMs >= 600_000)).toBe(true);
  });

  it("follows a recording the native tracker kept running while JavaScript restarted", async () => {
    const first = newHost();
    const sessionId = await started(first);
    const meters = await run(20, 0);
    first.dispose();
    const host = newHost();
    await host.recover();
    expect(sessionRow(sessionId)?.status).toBe("in_progress");
    expect(recordingOf(host).state.phase).toBe("recording");
    const before = recordingOf(host).live.distanceMm;
    await run(20, meters);
    expect(recordingOf(host).live.distanceMm).toBeGreaterThan(before);
  });

  it("finishes an interrupted session from the journal kept on storage", async () => {
    const first = newHost();
    const sessionId = await started(first);
    await run(30, 0);
    first.dispose();
    tracker.state = { state: "idle", sessionId: null };
    const host = newHost();
    await host.recover();
    await host.stop();
    await settle();
    expect(recordingOf(host).state).toMatchObject({ phase: "finishing", reason: "interruption" });
    const saved = await host.save();
    expect(saved.ok).toBe(true);
    expect(sessionRow(sessionId)?.status).toBe("completed");
  });
});
