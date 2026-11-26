import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readJournal } from "@obnixe/core";
import type { Id } from "@obnixe/schema";
import { StopwatchTracker, StopwatchTrackerError } from "@/features/tracking/stopwatchTracker";
import { journalUri } from "@/features/tracking/trackStore";
import { storedFiles } from "../../../test/mocks/expoFileSystem.ts";
import type { TrackerStartRequest } from "../../../modules/obnixe-tracker";

const sessionId = "01JD7Q0STOPWATCH00000000AA" as Id;

function requestOf(journal: TrackerStartRequest["journal"]): TrackerStartRequest {
  return {
    sessionId,
    journalPath: journalUri(sessionId),
    journal,
    power: "normal",
    sensors: { location: false, barometer: false, pedometer: false, bluetooth: [] },
    deliveryIntervalMs: 1000,
    backgroundDeliveryIntervalMs: 5000,
    notification: { title: "Natation · chronomètre", text: "", timerBaseAt: null, progress: null },
    replay: null,
  };
}

const journalOf = () => readJournal(storedFiles.get(journalUri(sessionId)) ?? new Uint8Array());

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: Date.UTC(2026, 10, 20, 7, 0) });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("stopwatch tracker", () => {
  it("REC-060 journals its marks on the wall clock and is found again by a new instance after a kill, without its torn tail", async () => {
    const first = new StopwatchTracker();
    const started = await first.start(requestOf("create"));
    expect(started.sources).toEqual({ location: null, barometer: false, pedometer: false, heartRate: false, cadence: false, power: false });
    vi.setSystemTime(Date.now() + 20_000);
    first.mark("pause");
    vi.setSystemTime(Date.now() + 10_000);
    first.mark("resume");
    first.mark("resume");
    vi.setSystemTime(Date.now() + 5_000);
    first.mark("lap");
    const valid = storedFiles.get(journalUri(sessionId))?.length ?? 0;
    storedFiles.set(journalUri(sessionId), new Uint8Array([...(storedFiles.get(journalUri(sessionId)) ?? []), 7, 0, 0]));

    const second = new StopwatchTracker();
    expect(second.status()).toEqual({ state: "recording", sessionId });
    expect(storedFiles.get(journalUri(sessionId))?.length).toBe(valid);
    await expect(second.start(requestOf("create"))).rejects.toBeInstanceOf(StopwatchTrackerError);
    vi.setSystemTime(Date.now() + 25_000);
    const stopped = await second.stop();
    expect(stopped).toEqual({ sessionId, endedAt: started.startedAt + 60_000, lastSequence: 4 });
    expect(journalOf().marks.map((mark) => `${mark.kind}@${mark.t}`)).toEqual(["start@0", "pause@20000", "resume@30000", "lap@35000", "stop@60000"]);
    expect(new StopwatchTracker().status()).toEqual({ state: "idle", sessionId: null });
  });

  it("REC-060 continues a stopped stopwatch with the gap closed by a stop mark", async () => {
    const tracker = new StopwatchTracker();
    await tracker.start(requestOf("create"));
    vi.setSystemTime(Date.now() + 10_000);
    await tracker.stop();
    vi.setSystemTime(Date.now() + 50_000);
    await tracker.start(requestOf("continue"));
    expect(journalOf().marks.map((mark) => `${mark.kind}@${mark.t}`)).toEqual(["start@0", "stop@10000", "start@60000"]);
    expect(journalOf().lastSequence).toBe(2);
  });
});
