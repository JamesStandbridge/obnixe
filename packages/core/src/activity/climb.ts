import { and, asc, desc, eq, inArray, isNull, max, ne } from "drizzle-orm";
import { gradeScales, painReport, session, sessionItem, sports } from "@obnixe/schema";
import type { EpochMs, FieldValues, GradeScaleKey, GradeValue, Id, Session, SessionItem } from "@obnixe/schema";
import type { Environment, ObnixeDatabase } from "../database.ts";
import type { Mutation } from "../writer.ts";
import { localDateOf } from "./dates.ts";
import type { SlotLink } from "./freeSession.ts";
import { evaluateIndicators, parseGrade } from "./indicators.ts";

export const climbResults = ["flash", "sent", "project"] as const;
export type ClimbResult = (typeof climbResults)[number];

export const climbStyles = ["overhang", "slab", "crimps", "dyno"] as const;
export type ClimbStyle = (typeof climbStyles)[number];

export const climbDisciplines = ["boulder", "lead", "top_rope", "board"] as const;
export type ClimbDiscipline = (typeof climbDisciplines)[number];

export interface ClimbItemDraft {
  readonly grade: string;
  readonly attempts: number;
  readonly result: ClimbResult;
  readonly style: readonly ClimbStyle[];
}

export interface ClimbStart {
  readonly startedAt: EpochMs;
  readonly timeZone: string;
  readonly discipline: ClimbDiscipline;
  readonly place: string | null;
  readonly slot: SlotLink | null;
}

export interface ClimbDefaults {
  readonly discipline: ClimbDiscipline;
  readonly place: string | null;
}

export interface ClimbStartPlan {
  readonly sessionId: Id;
  readonly mutation: Mutation;
}

export interface ClimbItemPlan {
  readonly itemId: Id;
  readonly mutations: readonly Mutation[];
}

export interface ClimbSummary {
  readonly count: number;
  readonly maxSent: GradeValue | null;
  readonly flashes: number;
  readonly flashRate: number | null;
}

export class OpenSessionExistsError extends Error {
  constructor(readonly sessionId: Id) {
    super(`Session ${sessionId} is still open`);
  }
}

export class ScaleChangeError extends Error {
  constructor(readonly sessionId: Id, readonly from: GradeScaleKey, readonly to: GradeScaleKey) {
    super(`Session ${sessionId} has items graded in ${from}, cannot switch to ${to}`);
  }
}

export class NotClimbSessionError extends Error {
  constructor(readonly sessionId: Id) {
    super(`Session ${sessionId} is not an open climbing session`);
  }
}

export function isClimbDiscipline(value: unknown): value is ClimbDiscipline {
  return typeof value === "string" && (climbDisciplines as readonly string[]).includes(value);
}

export function isClimbResult(value: unknown): value is ClimbResult {
  return typeof value === "string" && (climbResults as readonly string[]).includes(value);
}

export function isClimbStyle(value: unknown): value is ClimbStyle {
  return typeof value === "string" && (climbStyles as readonly string[]).includes(value);
}

export function scaleForDiscipline(discipline: ClimbDiscipline): GradeScaleKey {
  return sports.climb.gradeScaleBy.scales[discipline];
}

export function disciplineOf(values: FieldValues): ClimbDiscipline {
  const discipline = values.discipline;
  if (!isClimbDiscipline(discipline)) throw new Error(`Invalid climbing discipline ${JSON.stringify(discipline)}`);
  return discipline;
}

export function findOpenSession(db: ObnixeDatabase): Session | null {
  return db
    .select()
    .from(session)
    .where(and(ne(session.status, "completed"), isNull(session.deletedAt)))
    .get() ?? null;
}

export function climbDefaults(db: ObnixeDatabase): ClimbDefaults {
  const last = db
    .select({ values: session.values })
    .from(session)
    .where(and(eq(session.sport, "climb"), isNull(session.deletedAt)))
    .orderBy(desc(session.startedAt))
    .get();
  if (last === undefined) return { discipline: "boulder", place: null };
  const place = last.values.place;
  return { discipline: isClimbDiscipline(last.values.discipline) ? last.values.discipline : "boulder", place: typeof place === "string" ? place : null };
}

function climbValues(discipline: ClimbDiscipline, place: string | null): FieldValues {
  const trimmed = place?.trim() ?? "";
  return trimmed === "" ? { discipline } : { discipline, place: trimmed };
}

export function planClimbStart(db: ObnixeDatabase, env: Environment, start: ClimbStart): ClimbStartPlan {
  const open = findOpenSession(db);
  if (open !== null) throw new OpenSessionExistsError(open.id);
  const sessionId = env.newId();
  return {
    sessionId,
    mutation: {
      kind: "insert",
      table: "session",
      row: {
        id: sessionId,
        sport: "climb",
        slotId: start.slot?.slotId ?? null,
        variantId: start.slot?.variantId ?? null,
        countsInRotation: start.slot?.countsInRotation ?? false,
        gearId: null,
        title: null,
        status: "in_progress",
        startedAt: start.startedAt,
        endedAt: null,
        pausedSeconds: 0,
        localDate: localDateOf(start.startedAt, start.timeZone),
        timeZone: start.timeZone,
        values: climbValues(start.discipline, start.place),
        effort: null,
        sensation: null,
        enjoyment: null,
        note: null,
        review: "pending",
        deletedAt: null,
      },
    },
  };
}

export function climbItems(db: ObnixeDatabase, sessionId: Id): SessionItem[] {
  return db.select().from(sessionItem).where(eq(sessionItem.sessionId, sessionId)).orderBy(asc(sessionItem.position)).all();
}

export function planClimbSettings(db: ObnixeDatabase, current: Session, discipline: ClimbDiscipline, place: string | null): Mutation {
  const from = scaleForDiscipline(disciplineOf(current.values));
  const to = scaleForDiscipline(discipline);
  if (from !== to && climbItems(db, current.id).length > 0) throw new ScaleChangeError(current.id, from, to);
  return { kind: "update", table: "session", key: current.id, patch: { values: climbValues(discipline, place) } };
}

export function climbItemValues(scale: GradeScaleKey, draft: ClimbItemDraft): FieldValues {
  const values: FieldValues = { grade: `${scale}:${draft.grade}`, attempts: draft.attempts, result: draft.result };
  return draft.style.length === 0 ? values : { ...values, style: [...draft.style] };
}

export function readClimbItem(values: FieldValues): ClimbItemDraft | null {
  const grade = parseGrade(values.grade);
  const attempts = values.attempts;
  const result = values.result;
  if (grade === null || typeof attempts !== "number" || !isClimbResult(result)) return null;
  const style = Array.isArray(values.style) ? values.style.filter(isClimbStyle) : [];
  return { grade: grade.grade, attempts, result, style };
}

export function normalizeDraft(draft: ClimbItemDraft): ClimbItemDraft {
  const attempts = Math.max(1, Math.round(draft.attempts));
  return { ...draft, attempts, result: attempts > 1 && draft.result === "flash" ? "sent" : draft.result };
}

export function planClimbItem(db: ObnixeDatabase, env: Environment, current: Session, draft: ClimbItemDraft, linkPainIds: readonly Id[]): ClimbItemPlan {
  if (current.sport !== "climb" || current.status === "completed") throw new NotClimbSessionError(current.id);
  const scale = scaleForDiscipline(disciplineOf(current.values));
  const last = db.select({ position: max(sessionItem.position) }).from(sessionItem).where(eq(sessionItem.sessionId, current.id)).get();
  const itemId = env.newId();
  const mutations: Mutation[] = [
    {
      kind: "insert",
      table: "session_item",
      row: { id: itemId, sessionId: current.id, position: (last?.position ?? -1) + 1, values: climbItemValues(scale, normalizeDraft(draft)), recordedAt: env.now() },
    },
  ];
  if (linkPainIds.length > 0) {
    const linkable = db
      .select({ id: painReport.id })
      .from(painReport)
      .where(and(inArray(painReport.id, [...linkPainIds]), eq(painReport.sessionId, current.id), isNull(painReport.sessionItemId), isNull(painReport.strengthSetId)))
      .all();
    for (const pain of linkable) mutations.push({ kind: "update", table: "pain_report", key: pain.id, patch: { sessionItemId: itemId } });
  }
  return { itemId, mutations };
}

export function planClimbItemUpdate(current: Session, item: SessionItem, draft: ClimbItemDraft): Mutation {
  const scale = scaleForDiscipline(disciplineOf(current.values));
  return { kind: "update", table: "session_item", key: item.id, patch: { values: climbItemValues(scale, normalizeDraft(draft)) } };
}

export function planClimbItemRemoval(db: ObnixeDatabase, itemId: Id): Mutation[] {
  const anchored = db.select({ id: painReport.id }).from(painReport).where(eq(painReport.sessionItemId, itemId)).all();
  return [
    ...anchored.map((pain): Mutation => ({ kind: "update", table: "pain_report", key: pain.id, patch: { sessionItemId: null } })),
    { kind: "delete", table: "session_item", key: itemId },
  ];
}

export function planSessionCompletion(env: Environment, current: Session): Mutation {
  if (current.status === "completed") throw new NotClimbSessionError(current.id);
  const now = env.now();
  return { kind: "update", table: "session", key: current.id, patch: { status: "completed", endedAt: (now < current.startedAt ? current.startedAt : now) as EpochMs, review: "pending" } };
}

export function climbSummary(items: readonly FieldValues[]): ClimbSummary {
  const results = evaluateIndicators(sports.climb, { durationSeconds: 0, values: {}, items });
  const maxSent = results.find((result) => result.key === "max_sent");
  const flashRate = results.find((result) => result.key === "flash_rate");
  return {
    count: items.length,
    maxSent: maxSent?.kind === "grade" ? maxSent.value : null,
    flashes: items.filter((item) => item.result === "flash").length,
    flashRate: flashRate?.kind === "number" ? flashRate.value : null,
  };
}

export function defaultGrade(db: ObnixeDatabase, scale: GradeScaleKey): string {
  const grades: readonly string[] = gradeScales[scale].grades;
  const recent = db
    .select({ values: sessionItem.values })
    .from(sessionItem)
    .innerJoin(session, eq(sessionItem.sessionId, session.id))
    .where(and(eq(session.sport, "climb"), isNull(session.deletedAt)))
    .orderBy(desc(sessionItem.recordedAt))
    .limit(30)
    .all();
  const sameScale = recent.map((row) => parseGrade(row.values.grade)).filter((grade) => grade !== null && grade.scale === scale);
  const best = sameScale.reduce((highest, grade) => (grade !== null && grade.rank > highest ? grade.rank : highest), -1);
  if (best >= 0) return grades[best] ?? grades[0] ?? "";
  return grades[Math.floor(grades.length / 5)] ?? grades[0] ?? "";
}
