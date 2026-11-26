import type { TrackerMarkKind } from "../types.ts";

/** Mark codes shared by the journal and the track; code 4 is `extend`, reserved for guided workouts (V2). */
export const markCodes: Readonly<Record<TrackerMarkKind, number>> = { start: 0, pause: 1, resume: 2, lap: 3, stop: 5 };

export const markByCode: Readonly<Record<number, TrackerMarkKind>> = { 0: "start", 1: "pause", 2: "resume", 3: "lap", 5: "stop" };
