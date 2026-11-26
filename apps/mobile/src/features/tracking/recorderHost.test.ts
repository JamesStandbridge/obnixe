import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { commit, defaultRecordingSettings, encodeJournalBatch, encodeJournalHeader, encodePolyline, newRoute, readJournal, recordingSettingsMutation, revert, routePathOf } from "@obnixe/core";
import type { Fix, JournalRecord, Mutation, RoutePoint, Sample, TrackerMarkKind } from "@obnixe/core";
import { bestEffort, lap, painReport, recording, route, session, settings } from "@obnixe/schema";
import type { EpochMs, Id, RecordingSettings, WorkoutPlan, WorkoutStep } from "@obnixe/schema";
import { RecorderHost } from "@/features/tracking/recorderHost";
import { StopwatchTracker } from "@/features/tracking/stopwatchTracker";
import type { RecorderFeedback, RecorderView, RecordingStart, RecordingView, TrackerPort } from "@/features/tracking/recorderHost";
import { journalUri, readTrackFile, writeRouteTrack } from "@/features/tracking/trackStore";
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
  readonly listeners: Listeners = { onSamples: new Set(), onMark: new Set(), onIssue: new Set(), onSensorDevice: new Set(), onWarmupFix: new Set() };
  readonly notifications: TrackerNotification[] = [];
  readonly powers: TrackerPower[] = [];
  readonly requests: TrackerStartRequest[] = [];
  state: TrackerStatus = { state: "idle", sessionId: null };
  startedAt = 0 as EpochMs;
  sequence = 0;
  /** Samples of the coming batch, not on storage yet, and how many of them went out in parts. */
  pending: Sample[] = [];
  delivered = 0;
  paused = false;
  stopped = false;
  lastT = 0;
  path = "";
  preparations = 0;
  cancellations = 0;

  addListener<Name extends keyof TrackerEvents>(name: Name, listener: TrackerEvents[Name]): { remove: () => void } {
    const set = this.listeners[name] as Set<TrackerEvents[Name]>;
    set.add(listener);
    return { remove: () => set.delete(listener) };
  }

  status(): TrackerStatus {
    return this.state;
  }

  async prepare(): Promise<void> {
    this.preparations += 1;
  }

  cancelPreparation(): void {
    this.cancellations += 1;
  }

  async start(request: TrackerStartRequest): Promise<{ startedAt: EpochMs; sources: { location: "replay"; barometer: false; pedometer: false; heartRate: false; cadence: false; power: false } }> {
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
    return { startedAt: this.startedAt, sources: { location: "replay", barometer: false, pedometer: false, heartRate: false, cadence: false, power: false } };
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

  /** Sends samples of the coming batch before it reaches storage; `silent` loses the part on the bridge. */
  deliver(samples: readonly Sample[], silent = false): void {
    const part = { sessionId: this.state.sessionId ?? "", sequence: this.sequence, offset: this.delivered, samples, end: false };
    this.pending.push(...samples);
    this.delivered += samples.length;
    if (!silent) for (const listener of this.listeners.onSamples) listener(part);
  }

  /** Appends the coming batch with `samples` and `mark`, then sends its last part; `silent` loses both events on the bridge. */
  write(samples: readonly Sample[], mark: TrackerMarkKind | null, markT: number, silent = false): void {
    const rest = [...this.pending.slice(this.delivered), ...samples];
    const offset = this.delivered;
    const records: JournalRecord[] = [...this.pending, ...samples];
    if (mark !== null) records.push({ type: "mark", kind: mark, t: markT });
    this.pending = [];
    this.delivered = 0;
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
    for (const listener of this.listeners.onSamples) listener({ sessionId, sequence, offset, samples: rest, end: true });
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

const start: RecordingStart = { request: { sport: "run", values: {}, gearId: null, slot: null, timeZone: "Europe/Paris", routeId: null, workout: null, stopwatch: false }, autoPause: false, power: "normal", replay: null };

let tracker: FakeTracker;
let feedback: RecorderFeedback & { readonly calls: string[] };
let hosts: RecorderHost[];

function newHost(): RecorderHost {
  const host = new RecorderHost({ stopwatch: new StopwatchTracker(), tracker, writer, feedback });
  hosts.push(host);
  return host;
}

async function settle(): Promise<void> {
  for (let round = 0; round < 5; round += 1) await new Promise<void>((resolve) => setImmediate(resolve));
}

/** Runs `seconds` of steady running at 3 m/s with the screen on: a part every second, a batch on storage every 5 s (PRF-051). */
async function run(seconds: number, fromMeters: number): Promise<number> {
  let meters = fromMeters;
  for (let second = 1; second <= seconds; second += 1) {
    await vi.advanceTimersByTimeAsync(1000);
    meters += 3;
    tracker.deliver([fixAt(tracker.now(), meters)]);
    if (second % 5 === 0) tracker.write([], null, 0);
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
const routeRow = (id: Id) => db().select().from(route).where(eq(route.id, id)).get();

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

  it("PLT-020 records nothing without the native tracker, as on the web", async () => {
    const host = new RecorderHost({ stopwatch: new StopwatchTracker(), tracker: null, writer, feedback });
    hosts.push(host);
    expect(await host.prepare()).toEqual({ ok: false, failure: { kind: "unsupported" } });
    expect(await host.start(start)).toEqual({ ok: false, failure: { kind: "unsupported" } });
    expect(host.getView().kind).toBe("idle");
    expect(db().select().from(session).all()).toEqual([]);
  });

  it("REC-012 warms the receiver up on the preparation screen and NRG-002 stops it when leaving without a start", async () => {
    const host = newHost();
    const prepared = await host.prepare();
    expect(prepared.ok).toBe(true);
    expect(tracker.preparations).toBe(1);
    expect(host.getView().kind).toBe("preparing");
    host.cancelPreparation();
    expect(tracker.cancellations).toBe(1);
    expect(host.getView().kind).toBe("idle");
    host.cancelPreparation();
    expect(tracker.cancellations).toBe(1);
  });

  it("PRF-041 publishes the live view at most once a second", async () => {
    const host = newHost();
    await started(host);
    let published = 0;
    const unsubscribe = host.subscribe(() => {
      published += 1;
    });
    let meters = 0;
    for (let step = 0; step < 50; step += 1) {
      await vi.advanceTimersByTimeAsync(100);
      meters += 0.3;
      tracker.write([fixAt(tracker.now(), meters)], null, 0);
      await settle();
    }
    unsubscribe();
    expect(published).toBeGreaterThanOrEqual(4);
    expect(published).toBeLessThanOrEqual(6);
  });

  it("refuses a second open session and a start without storage (REC-003)", async () => {
    const host = newHost();
    const sessionId = await started(host);
    expect(await host.start(start)).toEqual({ ok: false, failure: { kind: "busy" } });
    const outsider = new RecorderHost({ stopwatch: new StopwatchTracker(), tracker: new FakeTracker(), writer, feedback });
    hosts.push(outsider);
    expect(await outsider.start(start)).toEqual({ ok: false, failure: { kind: "open_session", sessionId } });
    Paths.availableDiskSpace = 1024;
    try {
      const blocked = new RecorderHost({ stopwatch: new StopwatchTracker(), tracker: new FakeTracker(), writer, feedback });
      hosts.push(blocked);
      expect(await blocked.start(start)).toEqual({ ok: false, failure: { kind: "storage_full" } });
    } finally {
      Paths.availableDiskSpace = 64 * 1024 * 1024 * 1024;
    }
  });

  it("stops the tracker and deletes the journal when the start commit fails", async () => {
    const failing = new RecorderHost({
      stopwatch: new StopwatchTracker(),
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

  it("PRF-051 shows every second with the screen on while the journal takes a batch every 5 s, and reads lost parts back", async () => {
    const host = newHost();
    await started(host);
    expect(tracker.requests.at(-1)).toMatchObject({ deliveryIntervalMs: 1000 });
    const batchesAtStart = tracker.sequence;
    let meters = 0;
    let shown = 0;
    for (let second = 1; second <= 60; second += 1) {
      await vi.advanceTimersByTimeAsync(1000);
      meters += 3;
      tracker.deliver([fixAt(tracker.now(), meters)]);
      if (second % 5 === 0) tracker.write([], null, 0);
      await settle();
      const distance = recordingOf(host).live.distanceMm;
      if (second > 5) expect(distance).toBeGreaterThan(shown);
      shown = distance;
    }
    expect(tracker.sequence - batchesAtStart).toBe(12);
    expect(readJournal(storedFiles.get(tracker.path) ?? new Uint8Array()).lastSequence).toBe(tracker.sequence - 1);
    await vi.advanceTimersByTimeAsync(1000);
    tracker.deliver([{ type: "heart_rate", t: tracker.now(), bpm: 171, contact: "contact", rrInterval: null }, fixAt(tracker.now(), (meters += 3))], true);
    let frozen: number | null = null;
    for (let second = 2; second <= 4; second += 1) {
      await vi.advanceTimersByTimeAsync(1000);
      tracker.deliver([fixAt(tracker.now(), (meters += 3))]);
      await settle();
      const { distanceMm, heartRate } = recordingOf(host).live;
      expect(heartRate).toBeNull();
      if (frozen !== null) expect(distanceMm).toBe(frozen);
      frozen = distanceMm;
    }
    await vi.advanceTimersByTimeAsync(1000);
    tracker.write([fixAt(tracker.now(), (meters += 3))], null, 0);
    await settle();
    await vi.advanceTimersByTimeAsync(1000);
    expect(recordingOf(host).live.heartRate).toBe(171);
    expect(recordingOf(host).live.distanceMm).toBeGreaterThan(shown + 12_000);
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

  it("announces a known segment on entry, then its time at the end (SEG-004)", async () => {
    const latitudeE7 = Int32Array.from({ length: 7 }, (_, index) => Math.round((451_885_000 + (300 + index * 50) / metersPerE7) / 10) * 10);
    const longitudeE7 = new Int32Array(7).fill(57_245_000);
    const south = latitudeE7[0] ?? 0;
    const north = latitudeE7[6] ?? 0;
    writer.write("Segment", [
      {
        kind: "insert",
        table: "segment",
        row: {
          id: environment.newId(),
          name: "Ligne droite",
          family: "foot",
          polyline: encodePolyline({ length: 7, latitudeE7, longitudeE7 }, 6),
          distanceMm: 300_000,
          ascentMm: 0,
          bbox: { south, west: 57_245_000, north, east: 57_245_000 },
          south,
          north,
          sourceSessionId: null,
          deletedAt: null,
        },
      },
    ]);
    const host = newHost();
    await started(host);
    await run(250, 0);
    expect(feedback.calls.filter((call) => call.startsWith("alert:"))).toEqual(["alert:segment_entered", "alert:segment_finished"]);
    expect(recordingOf(host).alert?.notice).toMatchObject({ title: expect.stringMatching(/^Ligne droite · 1:\d\d$/), detail: "Premier passage" });
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
    tracker.issue("power_lost");
    await settle();
    expect(recordingOf(host).alert?.event).toEqual({ kind: "sensor", sensor: "power", change: "lost" });
    tracker.write([{ type: "power", t: tracker.now(), watts: 251, cadence: null }], null, 0);
    await settle();
    expect(recordingOf(host).issues).not.toContain("power_lost");
    expect(recordingOf(host).alert?.event).toEqual({ kind: "sensor", sensor: "power", change: "back" });
    expect(feedback.calls.filter((call) => call.startsWith("alert:"))).toEqual(["alert:gps", "alert:gps", "alert:battery", "alert:sensor", "alert:sensor", "alert:sensor", "alert:sensor"]);
  });

  it("connects the paired sources by their address and service and names them on the recording (SPT-007, SPT-008)", async () => {
    runSettings({ heartRateDevice: { id: "C4:7D:2A:10:9E:01", name: "Venu 3S" }, cadenceDevice: { id: "D0:5F:11:22:33:44", name: "Stryd" }, powerDevice: { id: "D0:5F:11:22:33:44", name: "Stryd" } });
    const host = newHost();
    const sessionId = await started(host);
    expect(tracker.requests[0]?.sensors.bluetooth).toEqual([
      { service: "heart_rate", id: "C4:7D:2A:10:9E:01" },
      { service: "running_speed_cadence", id: "D0:5F:11:22:33:44" },
      { service: "cycling_power", id: "D0:5F:11:22:33:44" },
    ]);
    expect(recordingRow(sessionId)).toMatchObject({ heartRateDevice: "Venu 3S", cadenceDevice: "Stryd", powerDevice: "Stryd" });
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
  it("interrupts at the last journaled instant when the tracker died, then resumes with the gap as a pause (REC-081, PLT-010)", async () => {
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

describe("guided workout", () => {
  const timed = (intent: WorkoutStep["intent"], seconds: number): WorkoutStep => ({ type: "step", intent, duration: { kind: "time", ms: seconds * 1000 }, target: { kind: "none" }, label: null });
  const workout: WorkoutPlan = {
    version: 1,
    nodes: [
      timed("warmup", 30),
      { type: "repeat", count: 2, steps: [{ type: "step", intent: "work", duration: { kind: "distance", mm: 150_000 }, target: { kind: "none" }, label: null }, timed("recovery", 20)] },
      { type: "step", intent: "cooldown", duration: { kind: "open" }, target: { kind: "none" }, label: null },
    ],
  };
  const guided: RecordingStart = { ...start, request: { ...start.request, workout } };

  async function startedGuided(host: RecorderHost): Promise<Id> {
    const outcome = await host.start(guided);
    if (!outcome.ok) throw new Error(`Start failed: ${outcome.failure.kind}`);
    await settle();
    return outcome.value;
  }

  const stepAlerts = (): number => feedback.calls.filter((call) => call === "alert:workout_step").length;

  it("delivers every second with the screen off, announces each step and saves one lap per step (WKT-006, WKT-007, WKT-009)", async () => {
    const host = newHost();
    const sessionId = await startedGuided(host);
    expect(tracker.requests.at(-1)).toMatchObject({ deliveryIntervalMs: 1000, backgroundDeliveryIntervalMs: 1000 });
    expect(recordingRow(sessionId)?.workout).toEqual(workout);
    expect(recordingOf(host).workout).toMatchObject({ started: true, current: { index: 0, intent: "warmup" }, next: { index: 1 } });
    let meters = await run(200, 0);
    expect(stepAlerts()).toBe(6);
    expect(recordingOf(host).workout).toMatchObject({ current: { index: 5, intent: "cooldown" }, remaining: { kind: "open" } });
    expect(recordingOf(host).alert?.notice).toMatchObject({ title: "Retour au calme", detail: "Jusqu'à l'étape suivante" });
    expect(host.lap().ok).toBe(true);
    await settle();
    expect(stepAlerts()).toBe(7);
    expect(recordingOf(host).alert?.notice.title).toBe("Séance terminée");
    expect(feedback.calls).not.toContain("alert:lap");
    meters = await run(10, meters);
    await host.stop();
    await settle();
    const laps = recordingOf(host).summary?.processed.laps.map((summary) => ({ trigger: summary.bounds.trigger, workoutStep: summary.bounds.workoutStep }));
    expect(laps).toEqual([...[0, 1, 2, 3, 4, 5].map((workoutStep) => ({ trigger: "workout", workoutStep })), { trigger: "manual", workoutStep: null }]);
    const saved = await host.save();
    expect(saved.ok).toBe(true);
    expect(db().select({ workoutStep: lap.workoutStep }).from(lap).where(eq(lap.sessionId, sessionId)).all().map((row) => row.workoutStep)).toEqual([0, 1, 2, 3, 4, 5, null]);
    expect(meters).toBeGreaterThan(600);
  });

  it("delivers every 5 s with the screen off without a workout (PRF-051)", async () => {
    await started(newHost());
    expect(tracker.requests.at(-1)).toMatchObject({ deliveryIntervalMs: 1000, backgroundDeliveryIntervalMs: 5000 });
    expect(recordingOf(hosts[0] as RecorderHost).workout).toBeNull();
  });

  it("finds its step again from the journal at launch", async () => {
    const first = newHost();
    await startedGuided(first);
    const meters = await run(40, 0);
    first.dispose();
    const host = newHost();
    await host.recover();
    expect(recordingOf(host).workout).toMatchObject({ current: { index: 1, intent: "work" } });
    const before = feedback.calls.length;
    await run(65, meters);
    expect(feedback.calls.slice(before).filter((call) => call === "alert:workout_step")).toHaveLength(2);
    expect(recordingOf(host).workout?.current?.index).toBe(3);
  });
});

describe("followed route", () => {
  /** North from the start of the runs for `northMeters`, then east for 2 km. */
  async function savedRoute(northMeters: number): Promise<Id> {
    const north = Array.from({ length: northMeters / 10 + 1 }, (_, index): RoutePoint => ({ latitudeE7: 451_885_000 + Math.round((index * 10) / metersPerE7), longitudeE7: 57_245_000, altitudeMm: 250_000 }));
    const corner = north.at(-1) ?? north[0];
    const east = Array.from({ length: 200 }, (_, index): RoutePoint => ({ latitudeE7: corner?.latitudeE7 ?? 0, longitudeE7: 57_245_000 + Math.round(((index + 1) * 10) / (metersPerE7 * Math.cos((45.19 * Math.PI) / 180))), altitudeMm: 250_000 }));
    const plan = newRoute(environment, { name: "Bastille", sport: "run", path: routePathOf([...north, ...east]), elevationSource: "file", sourceSessionId: null });
    await writeRouteTrack(plan.routeId, plan.file.bytes);
    writer.write("route", [plan.mutation]);
    return plan.routeId;
  }

  const along = (routeId: Id): RecordingStart => ({ ...start, request: { ...start.request, routeId } });

  it("shows the route and what is left of it while recording, then dates its last use (RTE-003)", async () => {
    const routeId = await savedRoute(2000);
    const host = newHost();
    const outcome = await host.start(along(routeId));
    if (!outcome.ok) throw new Error(`Start failed: ${outcome.failure.kind}`);
    await settle();
    expect(recordingOf(host).route).toMatchObject({ routeId, name: "Bastille" });
    await run(60, 0);
    const { live } = recordingOf(host);
    expect(live.route).toMatchObject({ joined: true, offRoute: false });
    expect(live.route?.progress).toBeGreaterThan(150);
    expect(live.metrics.route_remaining).toBe(live.route?.remaining);
    expect(live.metrics.route_progress).toBe(live.route?.fraction);
    expect(recordingRow(outcome.value)?.routeId).toBe(routeId);
    expect(db().select({ lastUsedAt: route.lastUsedAt }).from(route).where(eq(route.id, routeId)).get()?.lastUsedAt).toBe(tracker.startedAt);
  });

  it("warns once off the route and says where it is (RTE-005)", async () => {
    const routeId = await savedRoute(150);
    const host = newHost();
    const outcome = await host.start(along(routeId));
    if (!outcome.ok) throw new Error(`Start failed: ${outcome.failure.kind}`);
    await settle();
    await run(120, 0);
    expect(feedback.calls).toContain("alert:route");
    expect(recordingOf(host).live.route?.offRoute).toBe(true);
    expect(recordingOf(host).live.route?.rejoin).not.toBeNull();
  });

  it("refuses a route gone or unreadable before anything starts", async () => {
    const host = newHost();
    expect(await host.start(along("gone" as Id))).toEqual({ ok: false, failure: { kind: "route_unavailable" } });
    const routeId = await savedRoute(500);
    const file = routeRow(routeId)?.trackFile ?? "";
    for (const uri of [...storedFiles.keys()]) if (uri.endsWith(`/${file}`)) storedFiles.delete(uri);
    expect(await host.start(along(routeId))).toEqual({ ok: false, failure: { kind: "route_unavailable" } });
    expect(tracker.state.state).toBe("idle");
    expect(db().select().from(session).all()).toEqual([]);
  });

  it("follows the route again after a restart", async () => {
    const routeId = await savedRoute(2000);
    const first = newHost();
    const outcome = await first.start(along(routeId));
    if (!outcome.ok) throw new Error(`Start failed: ${outcome.failure.kind}`);
    await settle();
    const meters = await run(40, 0);
    first.dispose();
    const host = newHost();
    await host.recover();
    expect(recordingOf(host).route?.routeId).toBe(routeId);
    await run(20, meters);
    expect(recordingOf(host).live.route?.progress).toBeGreaterThan(150);
  });
});

describe("stopwatch", () => {
  const pool: RecordingStart = { request: { ...start.request, sport: "swim", values: { water: "pool", pool_length: 25 }, stopwatch: true }, autoPause: false, power: "normal", replay: null };

  function stopwatchHost(native: TrackerPort | null = null): RecorderHost {
    const host = new RecorderHost({ stopwatch: new StopwatchTracker(), tracker: native, writer, feedback });
    hosts.push(host);
    return host;
  }

  async function startedStopwatch(host: RecorderHost, request: RecordingStart = pool): Promise<Id> {
    const outcome = await host.start(request);
    if (!outcome.ok) throw new Error(`Start failed: ${outcome.failure.kind}`);
    await settle();
    return outcome.value;
  }

  it("REC-060 times a pool swim without location nor native tracker, then saves the distance typed at the stop", async () => {
    const host = stopwatchHost();
    const sessionId = await startedStopwatch(host);
    expect(recordingRow(sessionId)).toMatchObject({ source: "stopwatch", autoPause: false });
    expect(recordingOf(host).profile).toMatchObject({ stopwatch: true, pacePerMeters: 100, cadence: "none" });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(recordingOf(host).live.movingMs).toBe(60_000);
    expect(host.lap().ok).toBe(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(host.pause().ok).toBe(true);
    await settle();
    await vi.advanceTimersByTimeAsync(30_000);
    expect((await host.resume()).ok).toBe(true);
    await settle();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(recordingOf(host).live.movingMs).toBe(180_000);
    expect((await host.stop()).ok).toBe(true);
    await settle();
    expect(recordingOf(host).summary?.processed.summary).toMatchObject({ elapsedMs: 210_000, movingMs: 180_000, distanceMm: 0 });
    expect(recordingOf(host).summary?.processed.laps.map((row) => row.movingMs)).toEqual([60_000, 120_000]);
    expect(host.setStopwatchDistance(400_000).ok).toBe(true);
    expect(recordingOf(host).summary).toMatchObject({ distanceMm: 400_000, processed: { summary: { distanceMm: 400_000, movingMs: 180_000 } } });
    const saved = await host.save();
    expect(saved.ok).toBe(true);
    expect(sessionRow(sessionId)?.status).toBe("completed");
    expect(recordingRow(sessionId)).toMatchObject({ source: "stopwatch", distanceMm: 400_000, movingMs: 180_000, pointCount: 0 });
    expect(db().select().from(lap).where(eq(lap.sessionId, sessionId)).all()).toHaveLength(2);
    expect(storedFiles.has(journalUri(sessionId))).toBe(false);
    expect(host.getView()).toEqual({ kind: "idle" });
  });

  it("REC-060 keeps the stopwatch running while the app is killed, then picks it back up from its journal", async () => {
    const first = stopwatchHost();
    const sessionId = await startedStopwatch(first);
    await vi.advanceTimersByTimeAsync(45_000);
    first.dispose();
    await vi.advanceTimersByTimeAsync(15_000);
    const host = stopwatchHost();
    await host.recover();
    expect(recordingOf(host)).toMatchObject({ sessionId, state: { phase: "recording" } });
    expect(recordingOf(host).live.movingMs).toBe(60_000);
    expect((await host.stop()).ok).toBe(true);
    await settle();
    expect(recordingOf(host).summary?.processed.summary.movingMs).toBe(60_000);
    expect((await host.save()).ok).toBe(true);
    expect(recordingRow(sessionId)).toMatchObject({ distanceMm: 0, movingMs: 60_000 });
  });

  it("REC-060 starts the native tracker without location when a heart-rate source is paired, and leaves the power meter out", async () => {
    writer.write("Réglages", [
      recordingSettingsMutation(db(), "bike", {
        ...defaultRecordingSettings({ autoPauseDefault: true }),
        heartRateDevice: { id: "C4:7D:2A:10:9E:01", name: "Venu 3S" },
        powerDevice: { id: "D1:22:33:44:55:66", name: "Assioma" },
      }),
    ]);
    const host = stopwatchHost(tracker);
    const sessionId = await startedStopwatch(host, { ...pool, request: { ...pool.request, sport: "bike", values: { kind: "indoor" } } });
    expect(tracker.requests[0]?.sensors).toEqual({ location: false, barometer: false, pedometer: false, bluetooth: [{ service: "heart_rate", id: "C4:7D:2A:10:9E:01" }] });
    expect(recordingRow(sessionId)).toMatchObject({ source: "stopwatch", heartRateDevice: "Venu 3S" });
    expect(tracker.requests[0]?.notification.title).toBe("Vélo · chronomètre");
  });
});
