import { and, desc, eq, isNull } from "drizzle-orm";
import { session } from "@obnixe/schema";
import type { Effort, EpochMs, FieldValues, Id, LocalDate, Sensation, Session, SportKey } from "@obnixe/schema";
import type { Environment, ObnixeDatabase } from "../database.ts";
import type { Mutation } from "../writer.ts";
import { emphasisQuantity, isFreeSport, sportOf } from "./catalog.ts";
import { localDateOf } from "./dates.ts";
import { sessionPainMutations } from "./pain.ts";
import type { ZonePain } from "./pain.ts";

export interface SlotLink {
  readonly slotId: Id;
  readonly variantId: Id | null;
  readonly countsInRotation: boolean;
}

export interface FreeSessionDraft {
  readonly sport: SportKey;
  readonly startedAt: EpochMs;
  readonly durationSeconds: number;
  readonly pausedSeconds: number;
  readonly timeZone: string;
  readonly values: FieldValues;
  readonly gearId: Id | null;
  readonly slot: SlotLink | null;
  readonly effort: Effort | null;
  readonly sensation: Sensation | null;
  readonly enjoyment: number | null;
  readonly note: string | null;
  readonly pains: readonly ZonePain[];
}

export interface FreeSessionPlan {
  readonly sessionId: Id;
  readonly mutations: readonly Mutation[];
}

export interface SessionSuggestion {
  readonly emphasis: number | null;
  readonly durationSeconds: number;
  readonly localDate: LocalDate;
}

export class NotFreeSportError extends Error {
  constructor(readonly sport: SportKey) {
    super(`${sport} is not logged as a free activity`);
  }
}

export class InvalidDurationError extends Error {
  constructor(readonly durationSeconds: number, readonly pausedSeconds: number) {
    super(`Invalid duration ${durationSeconds}s with ${pausedSeconds}s paused`);
  }
}

export class FutureSessionError extends Error {
  constructor(readonly startedAt: EpochMs) {
    super(`Session starts in the future at ${startedAt}`);
  }
}

export function activeSeconds(row: Pick<Session, "startedAt" | "endedAt" | "pausedSeconds">, now: EpochMs): number {
  const end = row.endedAt ?? now;
  return Math.max(0, Math.round((end - row.startedAt) / 1000) - row.pausedSeconds);
}

export function lastSessionSuggestion(db: ObnixeDatabase, sport: SportKey): SessionSuggestion | null {
  const last = db
    .select()
    .from(session)
    .where(and(eq(session.sport, sport), eq(session.status, "completed"), isNull(session.deletedAt)))
    .orderBy(desc(session.startedAt))
    .get();
  if (last === undefined) return null;
  const field = emphasisQuantity(sportOf(sport));
  const value = field === null ? undefined : last.values[field.key];
  return { emphasis: typeof value === "number" ? value : null, durationSeconds: activeSeconds(last, last.startedAt), localDate: last.localDate };
}

export function planFreeSession(db: ObnixeDatabase, env: Environment, draft: FreeSessionDraft): FreeSessionPlan {
  if (!isFreeSport(draft.sport)) throw new NotFreeSportError(draft.sport);
  if (!Number.isInteger(draft.durationSeconds) || draft.durationSeconds <= 0 || !Number.isInteger(draft.pausedSeconds) || draft.pausedSeconds < 0) {
    throw new InvalidDurationError(draft.durationSeconds, draft.pausedSeconds);
  }
  if (draft.startedAt > env.now()) throw new FutureSessionError(draft.startedAt);
  const sessionId = env.newId();
  const endedAt = (draft.startedAt + (draft.durationSeconds + draft.pausedSeconds) * 1000) as EpochMs;
  const note = draft.note?.trim() ?? "";
  const mutations: Mutation[] = [
    {
      kind: "insert",
      table: "session",
      row: {
        id: sessionId,
        sport: draft.sport,
        slotId: draft.slot?.slotId ?? null,
        variantId: draft.slot?.variantId ?? null,
        countsInRotation: draft.slot?.countsInRotation ?? false,
        gearId: sportOf(draft.sport).usesGear ? draft.gearId : null,
        title: null,
        status: "completed",
        startedAt: draft.startedAt,
        endedAt,
        pausedSeconds: draft.pausedSeconds,
        localDate: localDateOf(draft.startedAt, draft.timeZone),
        timeZone: draft.timeZone,
        values: draft.values,
        effort: draft.effort,
        sensation: draft.sensation,
        enjoyment: draft.enjoyment,
        note: note === "" ? null : note,
        review: "pending",
        deletedAt: null,
      },
    },
  ];
  const pains = sessionPainMutations(db, env, { sessionId, phase: "end", strengthSetId: null, sessionItemId: null, occurredAt: endedAt, timeZone: draft.timeZone }, draft.pains);
  return { sessionId, mutations: [...mutations, ...pains.mutations] };
}
