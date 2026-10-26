import { and, eq, isNull, sql } from "drizzle-orm";
import { measurement, measurementKind, session, settings, sports, zones } from "@obnixe/schema";
import type { EpochMs, Id, LocalDate, MeasurementKind, PainLevel, PainPhase, Session, SleepBucket } from "@obnixe/schema";
import type { ObnixeDatabase } from "../database.ts";
import { daysBetween, epochAt, localDateOf } from "../dates.ts";
import { sessionPainMutations } from "../activity/pain.ts";
import { planMeasurement, planMeasurementKind } from "../body/measurements.ts";
import { gramsToMass, planWeighIn } from "../body/weight.ts";
import { checkInAnswerMutations, checkInZoneMutations, todayCheckIn } from "../stats/checkin.ts";
import type { CheckInAnswer, CheckInContext } from "../stats/checkin.ts";
import { commit } from "../writer.ts";
import type { Actor, Mutation } from "../writer.ts";
import type { ToolInput } from "./contract.ts";
import type { AgentEnvironment, ToolResult } from "./environment.ts";
import { ToolInputError } from "./environment.ts";
import { frenchDay, plural } from "./format.ts";

const maxPastDays = 366;
const pastEntryMinutes = 8 * 60;

const levelWords: Readonly<Record<PainLevel, string>> = { none: "calme", discomfort: "gêne", stop: "arrêt" };

interface Day {
  readonly localDate: LocalDate;
  readonly occurredAt: EpochMs;
}

/** Past days are stamped at 08:00 local time, as the phone does for entries added afterwards. */
function resolveDay(env: AgentEnvironment, requested: string | undefined): Day {
  const now = env.now();
  const today = localDateOf(now, env.timeZone);
  if (requested === undefined || requested === today) return { localDate: today, occurredAt: now };
  const localDate = requested as LocalDate;
  const age = daysBetween(localDate, today);
  if (age < 0) throw new ToolInputError(`localDate ${requested} is in the future; today is ${today}.`);
  if (age > maxPastDays) throw new ToolInputError(`localDate ${requested} is more than ${maxPastDays} days ago.`);
  return { localDate, occurredAt: epochAt({ date: localDate, minutes: pastEntryMinutes }, env.timeZone) };
}

function checkInContext(env: AgentEnvironment, day: Day): CheckInContext {
  return { now: day.occurredAt, today: day.localDate, timeZone: env.timeZone, newId: env.newId };
}

function sleepWords(bucket: SleepBucket): string {
  switch (bucket) {
    case "lt6":
      return "moins de 6 h";
    case "h6":
      return "6 h";
    case "h7":
      return "7 h";
    case "h8":
      return "8 h";
    case "gte9":
      return "9 h ou plus";
    default: {
      const unreachable: never = bucket;
      throw new Error(`Unhandled sleep bucket ${String(unreachable)}`);
    }
  }
}

function frenchNumber(value: number): string {
  return value.toLocaleString("fr-FR", { maximumFractionDigits: 1 });
}

export function logCheckIn(db: ObnixeDatabase, env: AgentEnvironment, actor: Actor, input: ToolInput<"log_check_in">): ToolResult {
  const day = resolveDay(env, input.localDate);
  const existing = todayCheckIn(db, day.localDate).checkIn;
  const answer: CheckInAnswer = { ...(input.energy === undefined ? {} : { energy: input.energy }), ...(input.sleep === undefined ? {} : { sleep: input.sleep }) };
  const write = checkInAnswerMutations(existing, answer, checkInContext(env, day));
  if (write.mutations.length === 0) throw new ToolInputError(`The check-in of ${day.localDate} already has these values; nothing changed.`);
  const energy = input.energy ?? existing?.energy ?? null;
  const sleep = input.sleep ?? existing?.sleep ?? null;
  const parts = [energy === null ? null : `énergie ${energy}/5`, sleep === null ? null : `sommeil ${sleepWords(sleep)}`].filter((part): part is string => part !== null);
  const summary = `Check-in du ${frenchDay(day.localDate)} · ${parts.join(", ")}`;
  const changesetId = commit(db, env, { actor, summary, revertsId: null, mutations: write.mutations });
  return { kind: "write", summary, changesetId, data: { checkInId: write.checkInId, localDate: day.localDate, energy, sleep } };
}

function painMoment(row: Session, phase: PainPhase, now: EpochMs): EpochMs {
  switch (phase) {
    case "before":
      return row.startedAt;
    case "during":
    case "between":
      return row.endedAt === null ? now : (Math.round((row.startedAt + row.endedAt) / 2) as EpochMs);
    case "end":
      return row.endedAt ?? now;
    default: {
      const unreachable: never = phase;
      throw new Error(`Unhandled pain phase ${String(unreachable)}`);
    }
  }
}

function insertedPainReportId(mutations: readonly Mutation[]): Id | null {
  for (const mutation of mutations) if (mutation.kind === "insert" && mutation.table === "pain_report") return mutation.row.id;
  return null;
}

function opensZoneTracking(mutations: readonly Mutation[]): boolean {
  return mutations.some((mutation) => mutation.kind === "insert" && mutation.table === "zone_tracking");
}

function reportSessionPain(db: ObnixeDatabase, env: AgentEnvironment, actor: Actor, input: ToolInput<"report_pain">, sessionId: string): ToolResult {
  if (input.phase === undefined) throw new ToolInputError("'phase' is required with 'sessionId' (before, during, between or end).");
  if (input.localDate !== undefined) throw new ToolInputError("Omit 'localDate' with 'sessionId': the report takes the day of the session.");
  const row = db.select().from(session).where(and(eq(session.id, sessionId as Id), isNull(session.deletedAt))).get();
  if (row === undefined) throw new ToolInputError(`No session with id '${sessionId}'. Call get_history to find the session id.`);
  const plan = sessionPainMutations(
    db,
    env,
    { sessionId: row.id, phase: input.phase, sessionItemId: null, strengthSetId: null, occurredAt: painMoment(row, input.phase, env.now()), timeZone: row.timeZone },
    [{ zone: input.zone, level: input.level }],
  );
  const summary = `Douleur · ${zones[input.zone].label} : ${levelWords[input.level]} · ${sports[row.sport].label} du ${frenchDay(row.localDate)}`;
  const changesetId = commit(db, env, { actor, summary, revertsId: null, mutations: plan.mutations });
  return {
    kind: "write",
    summary,
    changesetId,
    data: { painReportId: plan.reportIds[0] ?? null, sessionId: row.id, localDate: row.localDate, zoneFollowUpOpened: opensZoneTracking(plan.mutations) },
  };
}

function reportCheckInPain(db: ObnixeDatabase, env: AgentEnvironment, actor: Actor, input: ToolInput<"report_pain">): ToolResult {
  if (input.phase !== undefined) throw new ToolInputError("'phase' is only allowed with 'sessionId'. Without a session the pain goes into the day's check-in.");
  const day = resolveDay(env, input.localDate);
  const current = todayCheckIn(db, day.localDate);
  const report = current.reports.find((item) => item.zone === input.zone) ?? null;
  const write = checkInZoneMutations(current.checkIn, report, input.zone, input.level, checkInContext(env, day));
  if (write.mutations.length === 0) throw new ToolInputError(`The check-in of ${day.localDate} already records ${input.zone} as ${input.level}; nothing changed.`);
  const summary = `Douleur · ${zones[input.zone].label} : ${levelWords[input.level]} · check-in du ${frenchDay(day.localDate)}`;
  const changesetId = commit(db, env, { actor, summary, revertsId: null, mutations: write.mutations });
  return {
    kind: "write",
    summary,
    changesetId,
    data: { painReportId: report?.id ?? insertedPainReportId(write.mutations), checkInId: write.checkInId, localDate: day.localDate, zoneFollowUpOpened: false },
  };
}

export function reportPain(db: ObnixeDatabase, env: AgentEnvironment, actor: Actor, input: ToolInput<"report_pain">): ToolResult {
  return input.sessionId === undefined ? reportCheckInPain(db, env, actor, input) : reportSessionPain(db, env, actor, input, input.sessionId);
}

export function logWeighIn(db: ObnixeDatabase, env: AgentEnvironment, actor: Actor, input: ToolInput<"log_weigh_in">): ToolResult {
  const day = resolveDay(env, input.localDate);
  const plan = planWeighIn(db, env, { grams: input.grams, occurredAt: day.occurredAt, timeZone: env.timeZone });
  if (plan.replaced !== null && plan.replaced.grams === input.grams) throw new ToolInputError(`The weigh-in of ${day.localDate} is already ${input.grams} g; nothing changed.`);
  const unit = db.select({ massUnit: settings.massUnit }).from(settings).get()?.massUnit ?? "kg";
  const summary = `Pesée du ${frenchDay(day.localDate)} · ${frenchNumber(gramsToMass(input.grams, unit))} ${unit}`;
  const changesetId = commit(db, env, { actor, summary, revertsId: null, mutations: [plan.mutation] });
  return { kind: "write", summary, changesetId, data: { weighInId: plan.weighInId, localDate: day.localDate, grams: input.grams, replacedGrams: plan.replaced?.grams ?? null } };
}

type MeasurementStatus = "added" | "replaced" | "unchanged";

interface ResolvedKind {
  readonly id: Id;
  readonly label: string;
  readonly mutation: Mutation | null;
}

function normalizedLabel(label: string): string {
  return label.trim().replace(/\s+/g, " ");
}

function kindByLabel(db: ObnixeDatabase, label: string): MeasurementKind | undefined {
  return db
    .select()
    .from(measurementKind)
    .where(sql`lower(${measurementKind.label}) = lower(${label})`)
    .get();
}

function activeKindLabels(db: ObnixeDatabase): string {
  const labels = db
    .select({ label: measurementKind.label })
    .from(measurementKind)
    .where(isNull(measurementKind.archivedAt))
    .all()
    .map((row) => `'${row.label}'`);
  return labels.length === 0 ? "none yet" : labels.join(", ");
}

function resolveKind(db: ObnixeDatabase, env: AgentEnvironment, reference: string, create: boolean, positionOffset: number): ResolvedKind {
  const byId = db.select().from(measurementKind).where(eq(measurementKind.id, reference as Id)).get();
  const label = normalizedLabel(reference);
  const found = byId ?? kindByLabel(db, label);
  if (found !== undefined && found.archivedAt === null) return { id: found.id, label: found.label, mutation: null };
  if (!create) {
    const reason = found === undefined ? "No measurement kind matches" : "The measurement kind is archived:";
    throw new ToolInputError(`${reason} '${reference}'. Existing kinds: ${activeKindLabels(db)}. Set createMissingKinds to true to create or restore it.`);
  }
  const plan = planMeasurementKind(db, env, found?.label ?? label);
  const mutation: Mutation = plan.mutation.kind === "insert" && plan.mutation.table === "measurement_kind" ? { ...plan.mutation, row: { ...plan.mutation.row, position: plan.mutation.row.position + positionOffset } } : plan.mutation;
  return { id: plan.kindId, label: found?.label ?? label, mutation };
}

export function logMeasurements(db: ObnixeDatabase, env: AgentEnvironment, actor: Actor, input: ToolInput<"log_measurements">): ToolResult {
  const day = resolveDay(env, input.localDate);
  const mutations: Mutation[] = [];
  const createdKinds: { id: Id; label: string }[] = [];
  const seen = new Set<Id>();
  const results: { kindId: Id; kind: string; millimeters: number; measurementId: Id; status: MeasurementStatus }[] = [];
  for (const entry of input.measurements) {
    const kind = resolveKind(db, env, entry.kind, input.createMissingKinds === true, createdKinds.length);
    if (seen.has(kind.id)) throw new ToolInputError(`Measurement kind '${kind.label}' is given twice.`);
    seen.add(kind.id);
    if (kind.mutation !== null) {
      mutations.push(kind.mutation);
      createdKinds.push({ id: kind.id, label: kind.label });
    }
    const existing = db
      .select()
      .from(measurement)
      .where(and(eq(measurement.kindId, kind.id), eq(measurement.localDate, day.localDate), isNull(measurement.deletedAt)))
      .get();
    if (existing !== undefined && existing.millimeters === entry.millimeters) {
      results.push({ kindId: kind.id, kind: kind.label, millimeters: entry.millimeters, measurementId: existing.id, status: "unchanged" });
      continue;
    }
    const plan = planMeasurement(db, env, { kindId: kind.id, millimeters: entry.millimeters, occurredAt: day.occurredAt, timeZone: env.timeZone });
    mutations.push(plan.mutation);
    results.push({ kindId: kind.id, kind: kind.label, millimeters: entry.millimeters, measurementId: plan.measurementId, status: existing === undefined ? "added" : "replaced" });
  }
  const changed = results.filter((result) => result.status !== "unchanged");
  const first = changed[0];
  if (first === undefined) throw new ToolInputError(`Every measurement of ${day.localDate} already has these values; nothing changed.`);
  const summary =
    changed.length === 1
      ? `Mensuration du ${frenchDay(day.localDate)} · ${first.kind} ${frenchNumber(first.millimeters / 10)} cm`
      : `Mensurations du ${frenchDay(day.localDate)} · ${plural(changed.length, "mesure", "mesures")}`;
  const changesetId = commit(db, env, { actor, summary, revertsId: null, mutations });
  return { kind: "write", summary, changesetId, data: { localDate: day.localDate, measurements: results, createdKinds } };
}