import type { TrackerMarkKind } from "../types.ts";

/** Mark codes shared by the journal and the track. */
export const markCodes: Readonly<Record<TrackerMarkKind, number>> = { start: 0, pause: 1, resume: 2, lap: 3, extend: 4, stop: 5 };

export const markByCode: Readonly<Record<number, TrackerMarkKind>> = { 0: "start", 1: "pause", 2: "resume", 3: "lap", 4: "extend", 5: "stop" };
