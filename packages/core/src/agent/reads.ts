import { and, asc, desc, eq, gte, inArray, isNull, lte, or } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import {
  catalogVersion,
  changeset,
  checkIn,
  exercise,
  exerciseNameKey,
  exerciseZone,
  gradeScales,
  measurement,
  measurementKind,
  painReport,
  photo,
  program,
  programItem,
  programSlot,
  programVariant,
  programVersion,
  session,
  sessionItem,
  sports,
  strengthEntry,
  strengthSet,
  weighIn,
  zones,
  zoneTracking,
} from "@obnixe/schema";
import type { EpochMs, Exercise, FieldDefinition, SportDefinition, Id, LocalDate, ProgramVersion, Session, StrengthSet } from "@obnixe/schema";
import type { ObnixeDatabase } from "../database.ts";
import { daysBetween, localDateOf } from "../dates.ts";
import { totalLoadGrams } from "../training/load.ts";
import type { ExerciseLoad } from "../training/load.ts";
import type { ToolInput } from "./contract.ts";
import type { AgentEnvironment, Json, ToolResult } from "./environment.ts";
import { ToolInputError } from "./environment.ts";
import { findExercise } from "./exercises.ts";
import { frenchSpan, lowerFirst } from "./format.ts";

const dayMs = 86_400_000;

function iso(epochMs: number | null): string | null {
  return epochMs === null ? null : new Date(epochMs).toISOString();
}

function durationSeconds(row: Pick<Session, "startedAt" | "endedAt" | "pausedSeconds">): number | null {
  if (row.endedAt === null) return null;
  return Math.max(0, Math.round((row.endedAt - row.startedAt) / 1000) - row.pausedSeconds);
}

function field(definition: FieldDefinition): Json {
  const base = { key: definition.key, label: definition.label, required: definition.required };
  switch (definition.type) {
    case "quantity":
      return { ...base, type: "quantity", dimension: definition.dimension, unit: dimensionUnits[definition.dimension], min: definition.min, max: definition.max };
    case "grade":
      return { ...base, type: "grade", values: definition.scales.flatMap((scale) => gradeScales[scale].grades.map((grade) => `${scale}:${grade}`)) };
    case "choice":
      return { ...base, type: "choice", multiple: definition.multiple, options: definition.options.filter((option) => option.retired !== true).map((option) => ({ key: option.key, label: option.label })) };
    case "text":
      return { ...base, type: "text" };
    case "toggle":
      return { ...base, type: "toggle" };
    default: {
      const unreachable: never = definition;
      throw new Error(`Unhandled field ${JSON.stringify(unreachable)}`);
    }
  }
}

const dimensionUnits = {
  mass: "grams",
  length: "millimeters",
  distance: "meters",
  duration: "seconds",
  count: "count",
  heart_rate: "beats per minute",
  power: "watts",
} as const;

const catalog: Readonly<Record<string, SportDefinition>> = sports;

export function listSports(): ToolResult {
  const list = Object.entries(catalog).map(([key, definition]) => ({
    key,
    label: definition.label,
    archetype: definition.archetype,
    sessionFields: definition.sessionFields.filter((item) => item.retired !== true).map(field),
    itemLabel: definition.itemLabel,
    itemFields: definition.itemFields.filter((item) => item.retired !== true).map(field),
    gradeScaleBy: definition.gradeScaleBy === null ? null : { field: definition.gradeScaleBy.field, scales: { ...definition.gradeScaleBy.scales } },
    painZones: definition.painZones.map((zone) => ({ key: zone, label: zones[zone].label })),
  }));
  return { kind: "read", summary: "Sports", data: { catalogVersion, sports: list, zones: Object.entries(zones).map(([key, zone]) => ({ key, label: zone.label })) } };
}

function rangeSummary(prefix: string, from: LocalDate, to: LocalDate, env: AgentEnvironment): string {
  const today = localDateOf(env.now(), env.timeZone);
  if (to === today) return `${prefix} des ${daysBetween(from, to) + 1} derniers jours`;
  return `${prefix} ${frenchSpan(from, to)}`;
}

function setJson(set: StrengthSet, load: ExerciseLoad): Json {
  return {
    position: set.position,
    loadGrams: set.loadGrams,
    totalLoadGrams: totalLoadGrams(set.loadGrams, load),
    reps: set.reps,
    durationSeconds: set.durationSeconds,
    rir: set.rir,
    restBeforeSeconds: set.restBeforeSeconds,
    interrupted: set.interrupted,
  };
}

export function getHistory(db: ObnixeDatabase, env: AgentEnvironment, input: ToolInput<"get_history">): ToolResult {
  const conditions: SQL[] = [gte(session.localDate, input.from as LocalDate), lte(session.localDate, input.to as LocalDate), isNull(session.deletedAt)];
  if (input.sport !== undefined) conditions.push(eq(session.sport, input.sport));
  const rows = db
    .select({ session, slotName: programSlot.name })
    .from(session)
    .leftJoin(programSlot, eq(session.slotId, programSlot.id))
    .where(and(...conditions))
    .orderBy(desc(session.startedAt))
    .all();
  const ids = rows.map((row) => row.session.id);
  const entries = ids.length === 0 ? [] : db.select({ entry: strengthEntry, name: exercise.name, loadMode: exercise.loadMode, baseGrams: exercise.baseGrams }).from(strengthEntry).innerJoin(exercise, eq(strengthEntry.exerciseId, exercise.id)).where(inArray(strengthEntry.sessionId, ids)).orderBy(asc(strengthEntry.position)).all();
  const entryIds = entries.map((row) => row.entry.id);
  const sets = entryIds.length === 0 ? [] : db.select().from(strengthSet).where(inArray(strengthSet.entryId, entryIds)).orderBy(asc(strengthSet.position)).all();
  const items = ids.length === 0 ? [] : db.select().from(sessionItem).where(inArray(sessionItem.sessionId, ids)).orderBy(asc(sessionItem.position)).all();
  const pains = ids.length === 0 ? [] : db.select().from(painReport).where(and(inArray(painReport.sessionId, ids), isNull(painReport.deletedAt))).orderBy(asc(painReport.occurredAt)).all();
  const sessions = rows.map(({ session: row, slotName }) => ({
    id: row.id,
    sport: row.sport,
    title: row.title,
    status: row.status,
    localDate: row.localDate,
    startedAt: iso(row.startedAt),
    durationSeconds: durationSeconds(row),
    programSlot: slotName,
    values: row.values,
    effort: row.effort,
    sensation: row.sensation,
    enjoyment: row.enjoyment,
    note: row.note,
    exercises: entries
      .filter((entry) => entry.entry.sessionId === row.id)
      .map(({ entry, name, loadMode, baseGrams }) => ({
        exercise: name,
        exerciseId: entry.exerciseId,
        loadMode,
        baseGrams,
        status: entry.status,
        note: entry.note,
        sets: sets.filter((set) => set.entryId === entry.id).map((set) => setJson(set, { loadMode, baseGrams })),
      })),
    items: items.filter((item) => item.sessionId === row.id).map((item) => ({ position: item.position, values: item.values })),
    pain: pains
      .filter((pain) => pain.sessionId === row.id)
      .map((pain) => ({ zone: pain.zone, zoneLabel: zones[pain.zone].label, level: pain.level, phase: pain.phase, note: pain.note })),
  }));
  const sportLabel = input.sport === undefined ? "" : `, ${lowerFirst(sports[input.sport].label)}`;
  return { kind: "read", summary: `${rangeSummary("Historique", input.from as LocalDate, input.to as LocalDate, env)}${sportLabel}`, data: { from: input.from, to: input.to, sessions } };
}

function progressArticle(name: string): string {
  const first = name.split(" ")[0] ?? name;
  return /[sx]$/i.test(first) ? "aux" : "au";
}

export function getExerciseProgress(db: ObnixeDatabase, _env: AgentEnvironment, input: ToolInput<"get_exercise_progress">): ToolResult {
  const target = findExercise(db, input.exercise);
  if (target === undefined) throw new ToolInputError(`No exercise matches '${input.exercise}'. Call list_exercises to see the available names.`);
  const merged = db.select({ id: exercise.id }).from(exercise).where(eq(exercise.mergedIntoId, target.id)).all();
  const exerciseIds = [target.id, ...merged.map((row) => row.id)];
  const conditions: SQL[] = [inArray(strengthEntry.exerciseId, exerciseIds), eq(session.status, "completed"), isNull(session.deletedAt)];
  if (input.from !== undefined) conditions.push(gte(session.localDate, input.from as LocalDate));
  if (input.to !== undefined) conditions.push(lte(session.localDate, input.to as LocalDate));
  const entries = db
    .select({ entryId: strengthEntry.id, sessionId: session.id, localDate: session.localDate, startedAt: session.startedAt, loadMode: exercise.loadMode, baseGrams: exercise.baseGrams })
    .from(strengthEntry)
    .innerJoin(session, eq(strengthEntry.sessionId, session.id))
    .innerJoin(exercise, eq(strengthEntry.exerciseId, exercise.id))
    .where(and(...conditions))
    .orderBy(asc(session.startedAt))
    .all();
  const sets = entries.length === 0 ? [] : db.select().from(strengthSet).where(inArray(strengthSet.entryId, entries.map((entry) => entry.entryId))).orderBy(asc(strengthSet.position)).all();
  const history = entries.map((entry) => {
    const load: ExerciseLoad = { loadMode: entry.loadMode, baseGrams: entry.baseGrams };
    const own = sets.filter((set) => set.entryId === entry.entryId && !set.interrupted);
    return {
      sessionId: entry.sessionId,
      localDate: entry.localDate,
      sets: own.map((set) => setJson(set, load)),
      bestSet: bestSet(target, own, load),
      estimatedOneRepMaxGrams: estimatedOneRepMax(own, load),
      volumeGramReps: own.reduce((total, set) => total + (totalLoadGrams(set.loadGrams, load) ?? 0) * (set.reps ?? 0), 0),
    };
  });
  return {
    kind: "read",
    summary: `Progression ${progressArticle(target.name)} ${lowerFirst(target.name)}`,
    data: {
      exercise: { id: target.id, name: target.name, measure: target.measure, equipment: target.equipment, loadMode: target.loadMode, baseGrams: target.baseGrams },
      sessions: history,
    },
  };
}

function bestSet(target: Exercise, sets: readonly StrengthSet[], load: ExerciseLoad): Json {
  const score = (set: StrengthSet): number => {
    const total = totalLoadGrams(set.loadGrams, load) ?? 0;
    return target.measure === "duration" ? (set.durationSeconds ?? 0) * 1_000_000 + total : total * 1000 + (set.reps ?? 0);
  };
  const best = [...sets].sort((left, right) => score(right) - score(left))[0];
  return best === undefined ? null : setJson(best, load);
}

function estimatedOneRepMax(sets: readonly StrengthSet[], load: ExerciseLoad): number | null {
  let best: number | null = null;
  for (const set of sets) {
    const total = totalLoadGrams(set.loadGrams, load);
    if (total === null || set.reps === null || total === 0) continue;
    const estimate = Math.round(total * (1 + set.reps / 30));
    if (best === null || estimate > best) best = estimate;
  }
  return best;
}

function rangeEpochs(from: string, to: string): { readonly start: number; readonly end: number } {
  return { start: Date.parse(`${from}T00:00:00Z`) - dayMs, end: Date.parse(`${to}T00:00:00Z`) + 2 * dayMs };
}

export function getBodySignals(db: ObnixeDatabase, env: AgentEnvironment, input: ToolInput<"get_body_signals">): ToolResult {
  const from = input.from as LocalDate;
  const to = input.to as LocalDate;
  const checkIns = db.select().from(checkIn).where(and(gte(checkIn.localDate, from), lte(checkIn.localDate, to), isNull(checkIn.deletedAt))).orderBy(asc(checkIn.localDate)).all();
  const pains = db.select().from(painReport).where(and(gte(painReport.localDate, from), lte(painReport.localDate, to), isNull(painReport.deletedAt))).orderBy(asc(painReport.occurredAt)).all();
  const window = rangeEpochs(input.from, input.to);
  const tracking = db
    .select()
    .from(zoneTracking)
    .where(and(lte(zoneTracking.startedAt, window.end as EpochMs), or(isNull(zoneTracking.endedAt), gte(zoneTracking.endedAt, window.start as EpochMs))))
    .orderBy(asc(zoneTracking.startedAt))
    .all();
  const data: Record<string, Json> = {
    from: input.from,
    to: input.to,
    bodyIncluded: env.permissions.canReadBody,
    checkIns: checkIns.map((row) => ({ localDate: row.localDate, energy: row.energy, sleep: row.sleep })),
    pain: pains.map((row) => ({
      localDate: row.localDate,
      zone: row.zone,
      zoneLabel: zones[row.zone].label,
      level: row.level,
      phase: row.phase,
      sessionId: row.sessionId,
      fromCheckIn: row.checkInId !== null,
      note: row.note,
    })),
    zoneTracking: tracking.map((row) => ({ zone: row.zone, zoneLabel: zones[row.zone].label, reason: row.reason, startedAt: iso(row.startedAt), endedAt: iso(row.endedAt) })),
  };
  if (env.permissions.canReadBody) {
    const weighIns = db.select().from(weighIn).where(and(gte(weighIn.localDate, from), lte(weighIn.localDate, to), isNull(weighIn.deletedAt))).orderBy(asc(weighIn.localDate)).all();
    const measurements = db
      .select({ row: measurement, label: measurementKind.label, zone: measurementKind.zone })
      .from(measurement)
      .innerJoin(measurementKind, eq(measurement.kindId, measurementKind.id))
      .where(and(gte(measurement.localDate, from), lte(measurement.localDate, to), isNull(measurement.deletedAt)))
      .orderBy(asc(measurement.localDate))
      .all();
    data.weighIns = weighIns.map((row) => ({ localDate: row.localDate, grams: row.grams }));
    data.measurements = measurements.map(({ row, label, zone }) => ({ localDate: row.localDate, kind: label, zone, millimeters: row.millimeters }));
  }
  const days = daysBetween(input.from as LocalDate, input.to as LocalDate) + 1;
  const subject = env.permissions.canReadBody ? "Douleurs, check-ins et poids" : "Douleurs et check-ins";
  return { kind: "read", summary: `${subject}, ${days} jours`, data };
}

export function listPhotos(db: ObnixeDatabase, _env: AgentEnvironment, input: ToolInput<"list_photos">): ToolResult {
  const conditions: SQL[] = [isNull(photo.deletedAt)];
  if (input.from !== undefined) conditions.push(gte(photo.localDate, input.from as LocalDate));
  if (input.to !== undefined) conditions.push(lte(photo.localDate, input.to as LocalDate));
  const rows = db.select().from(photo).where(and(...conditions)).orderBy(desc(photo.occurredAt)).all();
  return {
    kind: "read",
    summary: "Photos",
    data: { photos: rows.map((row) => ({ id: row.id, pose: row.pose, localDate: row.localDate, width: row.width, height: row.height })) },
  };
}

function latestVersion(db: ObnixeDatabase, programId: Id): ProgramVersion | undefined {
  return db.select().from(programVersion).where(eq(programVersion.programId, programId)).orderBy(desc(programVersion.number)).get();
}

export function listPrograms(db: ObnixeDatabase): ToolResult {
  const programs = db.select().from(program).orderBy(desc(program.updatedAt)).all();
  const list = programs.flatMap((row) => {
    const version = latestVersion(db, row.id);
    if (version === undefined) return [];
    return [{ id: row.id, status: row.status, name: version.name, latestVersion: version.number, sessionsPerWeek: version.sessionsPerWeek }];
  });
  return { kind: "read", summary: "Programmes", data: { programs: list } };
}

function versionTree(db: ObnixeDatabase, version: ProgramVersion): Json {
  const slots = db.select().from(programSlot).where(eq(programSlot.versionId, version.id)).orderBy(asc(programSlot.position)).all();
  return {
    id: version.id,
    number: version.number,
    name: version.name,
    sessionsPerWeek: version.sessionsPerWeek,
    createdAt: iso(version.createdAt),
    slots: slots.map((slot) => {
      const variants = db.select().from(programVariant).where(eq(programVariant.slotId, slot.id)).orderBy(asc(programVariant.position)).all();
      return {
        lineageId: slot.lineageId,
        name: slot.name,
        sport: slot.sport,
        targetDurationSeconds: slot.targetDurationSeconds,
        targetEffort: slot.targetEffort,
        targetValues: slot.targetValues,
        variants: variants.map((variant) => ({
          lineageId: variant.lineageId,
          name: variant.name,
          items: db
            .select({ item: programItem, name: exercise.name, measure: exercise.measure })
            .from(programItem)
            .innerJoin(exercise, eq(programItem.exerciseId, exercise.id))
            .where(eq(programItem.variantId, variant.id))
            .orderBy(asc(programItem.position))
            .all()
            .map(({ item, name, measure }) => ({
              lineageId: item.lineageId,
              exercise: name,
              exerciseId: item.exerciseId,
              measure,
              sets: item.sets,
              repsMin: item.repsMin,
              repsMax: item.repsMax,
              durationMinSeconds: item.durationMinSeconds,
              durationMaxSeconds: item.durationMaxSeconds,
              targetRir: item.targetRir,
              restSeconds: item.restSeconds,
              restAfterSeconds: item.restAfterSeconds,
            })),
        })),
      };
    }),
  };
}

export function getProgram(db: ObnixeDatabase, _env: AgentEnvironment, input: ToolInput<"get_program">): ToolResult {
  const row = db.select().from(program).where(eq(program.id, input.programId as Id)).get();
  const latest = row === undefined ? undefined : latestVersion(db, row.id);
  if (row === undefined || latest === undefined) throw new ToolInputError(`No program with id '${input.programId}'. Call list_programs to see the available ids.`);
  const data: Record<string, Json> = { id: row.id, status: row.status, latest: versionTree(db, latest) };
  if (input.includeHistory === true) {
    data.history = db
      .select({ version: programVersion, author: changeset.author })
      .from(programVersion)
      .innerJoin(changeset, eq(programVersion.changesetId, changeset.id))
      .where(eq(programVersion.programId, row.id))
      .orderBy(desc(programVersion.number))
      .all()
      .map(({ version, author }) => ({ number: version.number, name: version.name, summary: version.summary, reason: version.reason, author, createdAt: iso(version.createdAt) }));
  }
  return { kind: "read", summary: latest.name, data };
}

export function listExercises(db: ObnixeDatabase, _env: AgentEnvironment, input: ToolInput<"list_exercises">): ToolResult {
  const rows = db.select().from(exercise).where(isNull(exercise.mergedIntoId)).orderBy(asc(exercise.nameKey)).all();
  const query = input.query === undefined ? null : exerciseNameKey(input.query);
  const visible = rows.filter((row) => (input.includeArchived === true || row.archivedAt === null) && (query === null || row.nameKey.includes(query)));
  const zoneRows = visible.length === 0 ? [] : db.select().from(exerciseZone).where(inArray(exerciseZone.exerciseId, visible.map((row) => row.id))).all();
  return {
    kind: "read",
    summary: "Exercices",
    data: {
      exercises: visible.map((row) => ({
        id: row.id,
        name: row.name,
        measure: row.measure,
        equipment: row.equipment,
        loadMode: row.loadMode,
        baseGrams: row.baseGrams,
        loadStepGrams: row.loadStepGrams,
        archived: row.archivedAt !== null,
        zones: zoneRows.filter((zone) => zone.exerciseId === row.id).map((zone) => zone.zone),
      })),
    },
  };
}
