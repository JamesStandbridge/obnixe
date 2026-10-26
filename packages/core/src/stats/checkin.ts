import { and, eq, isNull } from "drizzle-orm";
import { checkIn, painReport } from "@obnixe/schema";
import type { CheckIn, EpochMs, Id, LocalDate, PainLevel, PainReport, SleepBucket, ZoneKey } from "@obnixe/schema";
import type { ObnixeDatabase } from "../database.ts";
import type { Mutation } from "../writer.ts";

export interface CheckInContext {
  readonly now: EpochMs;
  readonly today: LocalDate;
  readonly timeZone: string;
  readonly newId: () => Id;
}

export interface CheckInAnswer {
  readonly energy?: number | null;
  readonly sleep?: SleepBucket | null;
}

export interface CheckInWrite {
  readonly checkInId: Id;
  readonly mutations: readonly Mutation[];
}

export interface TodayCheckIn {
  readonly checkIn: CheckIn | null;
  readonly reports: readonly PainReport[];
}

export function todayCheckIn(db: ObnixeDatabase, today: LocalDate): TodayCheckIn {
  const row = db.select().from(checkIn).where(and(eq(checkIn.localDate, today), isNull(checkIn.deletedAt))).get() ?? null;
  const reports = row === null ? [] : db.select().from(painReport).where(and(eq(painReport.checkInId, row.id), isNull(painReport.deletedAt))).all();
  return { checkIn: row, reports };
}

interface InsertedCheckIn {
  readonly id: Id;
  readonly mutation: Mutation;
}

function insertCheckIn(context: CheckInContext, answer: CheckInAnswer): InsertedCheckIn {
  const id = context.newId();
  return {
    id,
    mutation: {
      kind: "insert",
      table: "check_in",
      row: {
        id,
        occurredAt: context.now,
        localDate: context.today,
        timeZone: context.timeZone,
        energy: answer.energy ?? null,
        sleep: answer.sleep ?? null,
        deletedAt: null,
      },
    },
  };
}

export function checkInAnswerMutations(existing: CheckIn | null, answer: CheckInAnswer, context: CheckInContext): CheckInWrite {
  if (existing === null) {
    const inserted = insertCheckIn(context, answer);
    return { checkInId: inserted.id, mutations: [inserted.mutation] };
  }
  const patch: { energy?: number | null; sleep?: SleepBucket | null; occurredAt?: EpochMs } = {};
  if (answer.energy !== undefined && answer.energy !== existing.energy) patch.energy = answer.energy;
  if (answer.sleep !== undefined && answer.sleep !== existing.sleep) patch.sleep = answer.sleep;
  if (Object.keys(patch).length === 0) return { checkInId: existing.id, mutations: [] };
  patch.occurredAt = context.now;
  return { checkInId: existing.id, mutations: [{ kind: "update", table: "check_in", key: existing.id, patch }] };
}

export function checkInZoneMutations(existing: CheckIn | null, report: PainReport | null, zone: ZoneKey, level: PainLevel | null, context: CheckInContext): CheckInWrite {
  if (report !== null && report.zone !== zone) throw new Error(`Report ${report.id} is about ${report.zone}, not ${zone}`);
  const mutations: Mutation[] = [];
  let checkInId: Id;
  if (existing === null) {
    if (level === null) throw new Error("Clearing a zone requires an existing check-in");
    const inserted = insertCheckIn(context, {});
    checkInId = inserted.id;
    mutations.push(inserted.mutation);
  } else {
    checkInId = existing.id;
  }
  if (report === null) {
    if (level === null) return { checkInId, mutations };
    mutations.push({
      kind: "insert",
      table: "pain_report",
      row: {
        id: context.newId(),
        zone,
        level,
        occurredAt: context.now,
        localDate: context.today,
        timeZone: context.timeZone,
        sessionId: null,
        phase: null,
        strengthSetId: null,
        sessionItemId: null,
        checkInId,
        note: null,
        deletedAt: null,
      },
    });
    return { checkInId, mutations };
  }
  if (level === null) {
    mutations.push({ kind: "update", table: "pain_report", key: report.id, patch: { deletedAt: context.now } });
    return { checkInId, mutations };
  }
  if (level === report.level) return { checkInId, mutations };
  mutations.push({ kind: "update", table: "pain_report", key: report.id, patch: { level, occurredAt: context.now } });
  return { checkInId, mutations };
}
