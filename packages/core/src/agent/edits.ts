import { asc, eq, inArray } from "drizzle-orm";
import { exercise, exerciseZone, painReport, program, session, sessionItem, sports, strengthEntry, strengthSet } from "@obnixe/schema";
import type { EpochMs, Exercise, FieldValues, Id, LocalDate, PainReport, Session, SessionItem, StrengthEntry, StrengthSet, ZoneKey } from "@obnixe/schema";
import type { ObnixeDatabase } from "../database.ts";
import { activeSeconds } from "../activity/freeSession.ts";
import { trashMutation, trashRetentionMs } from "../data/trash.ts";
import { planArchiveExercise, planRestoreExercise, planUpdateExercise, usesLoad } from "../programs/exercises.ts";
import type { ExerciseInput, ExerciseIssue } from "../programs/exercises.ts";
import { exerciseUsage, latestVersion } from "../programs/queries.ts";
import { planActivate, planArchive } from "../programs/status.ts";
import type { StatusRefusal } from "../programs/status.ts";
import { commit } from "../writer.ts";
import type { Actor, Mutation, NewRow } from "../writer.ts";
import type { ToolInput } from "./contract.ts";
import type { AgentEnvironment, ToolResult } from "./environment.ts";
import { ToolInputError } from "./environment.ts";
import { findExercise, planExercises } from "./exercises.ts";
import { frenchDay, plural } from "./format.ts";
import { commitExercises, futureToleranceMs, resolved, spread, validateSet } from "./writes.ts";
import type { SessionTiming } from "./writes.ts";

type SessionAction = "editing" | "deleting";

function editableSession(db: ObnixeDatabase, sessionId: string, action: SessionAction): Session {
  const row = db.select().from(session).where(eq(session.id, sessionId as Id)).get();
  if (row === undefined) throw new ToolInputError(`No session with id '${sessionId}'. Call get_history to see the session ids.`);
  if (row.deletedAt !== null) throw new ToolInputError(`Session '${sessionId}' is in the trash. The user can restore it from the phone.`);
  if (row.status !== "completed") {
    const state = row.status === "in_progress" ? "in progress" : "interrupted";
    throw new ToolInputError(`Session '${sessionId}' is still ${state} on the phone. Ask the user to finish it there before ${action} it.`);
  }
  return row;
}

function sessionLabel(row: Pick<Session, "sport" | "localDate">): string {
  return `${sports[row.sport].label} du ${frenchDay(row.localDate)}`;
}

function completedTiming(row: Session): SessionTiming {
  return { startedAt: row.startedAt, endedAt: row.endedAt ?? row.startedAt, localDate: row.localDate };
}

function correctedTiming(env: AgentEnvironment, current: Session, input: ToolInput<"update_session">): SessionTiming {
  const startedAt = (input.startedAt === undefined ? current.startedAt : Date.parse(input.startedAt)) as EpochMs;
  const seconds = input.durationSeconds ?? activeSeconds(current, env.now());
  const endedAt = (startedAt + (seconds + current.pausedSeconds) * 1000) as EpochMs;
  if (endedAt > env.now() + futureToleranceMs) throw new ToolInputError("The session must be finished: startedAt + durationSeconds is in the future.");
  const localDate = input.startedAt === undefined ? current.localDate : (input.startedAt.slice(0, 10) as LocalDate);
  return { startedAt, endedAt, localDate };
}

type SessionPatch = Partial<NewRow<"session">>;

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function changedFields(current: Session, patch: SessionPatch): SessionPatch {
  const changed: Record<string, unknown> = {};
  for (const [column, value] of Object.entries(patch)) {
    if (!sameValue(current[column as keyof Session], value)) changed[column] = value;
  }
  return changed as SessionPatch;
}

function sessionPatch(env: AgentEnvironment, current: Session, input: ToolInput<"update_session">): SessionPatch {
  const patch: SessionPatch = {};
  if (input.startedAt !== undefined || input.durationSeconds !== undefined) {
    const timing = correctedTiming(env, current, input);
    patch.startedAt = timing.startedAt;
    patch.endedAt = timing.endedAt;
    patch.localDate = timing.localDate;
  }
  if (input.values !== undefined) patch.values = input.values;
  if (input.effort !== undefined) patch.effort = input.effort;
  if (input.sensation !== undefined) patch.sensation = input.sensation;
  if (input.enjoyment !== undefined) patch.enjoyment = input.enjoyment;
  if (input.title !== undefined) patch.title = input.title;
  if (input.note !== undefined) patch.note = input.note;
  return changedFields(current, patch);
}

interface ItemReplacement {
  readonly release: readonly Mutation[];
  readonly insert: readonly Mutation[];
}

function itemMutations(db: ObnixeDatabase, env: AgentEnvironment, sessionId: Id, items: readonly FieldValues[], timing: SessionTiming): ItemReplacement {
  const previous: readonly SessionItem[] = db.select().from(sessionItem).where(eq(sessionItem.sessionId, sessionId)).orderBy(asc(sessionItem.position)).all();
  const previousIds = previous.map((item) => item.id);
  const anchored: readonly PainReport[] = previousIds.length === 0 ? [] : db.select().from(painReport).where(inArray(painReport.sessionItemId, previousIds)).all();
  const nextIds = items.map((): Id => env.newId());
  const release: Mutation[] = [
    ...anchored.map((pain): Mutation => ({ kind: "update", table: "pain_report", key: pain.id, patch: { sessionItemId: null } })),
    ...previous.map((item): Mutation => ({ kind: "delete", table: "session_item", key: item.id })),
  ];
  const insert: Mutation[] = items.map(
    (values, position): Mutation => ({
      kind: "insert",
      table: "session_item",
      row: { id: nextIds[position] as Id, sessionId, position, values, recordedAt: previous[position]?.recordedAt ?? spread(timing, position, items.length) },
    }),
  );
  const reanchor = anchored.flatMap((pain): Mutation[] => {
    const nextId = nextIds[previousIds.indexOf(pain.sessionItemId as Id)];
    return nextId === undefined ? [] : [{ kind: "update", table: "pain_report", key: pain.id, patch: { sessionItemId: nextId } }];
  });
  return { release, insert: [...insert, ...reanchor] };
}

export function updateSession(db: ObnixeDatabase, env: AgentEnvironment, actor: Actor, input: ToolInput<"update_session">): ToolResult {
  const current = editableSession(db, input.sessionId, "editing");
  const sport = sports[current.sport];
  if (sport.archetype === "strength" && (input.values !== undefined || input.items !== undefined)) {
    throw new ToolInputError("Strength sessions have no values or items. Correct exercises and sets with update_strength_session.");
  }
  if (input.items !== undefined && sport.archetype !== "itemized") throw new ToolInputError(`${current.sport} sessions have no items; put everything in 'values'.`);
  const patch = sessionPatch(env, current, input);
  if (Object.keys(patch).length === 0 && input.items === undefined) throw new ToolInputError("Nothing to change: every field sent already has this value.");
  const final = { ...current, ...patch } as Session;
  const items = input.items === undefined ? null : itemMutations(db, env, current.id, input.items, completedTiming(final));
  const mutations: Mutation[] = [
    ...(items?.release ?? []),
    ...(Object.keys(patch).length === 0 ? [] : [{ kind: "update", table: "session", key: current.id, patch } satisfies Mutation]),
    ...(items?.insert ?? []),
  ];
  const summary = `Séance corrigée · ${sessionLabel(final)}`;
  const changesetId = commit(db, env, { actor, summary, revertsId: null, mutations });
  const changed = [...Object.keys(patch), ...(input.items === undefined ? [] : ["items"])];
  return { kind: "write", summary, changesetId, data: { sessionId: current.id, localDate: final.localDate, changed } };
}

interface PreviousEntry {
  readonly entry: StrengthEntry;
  readonly sets: readonly StrengthSet[];
}

function previousEntries(db: ObnixeDatabase, sessionId: Id): readonly PreviousEntry[] {
  const entries = db.select().from(strengthEntry).where(eq(strengthEntry.sessionId, sessionId)).orderBy(asc(strengthEntry.position)).all();
  const entryIds = entries.map((entry) => entry.id);
  const sets = entryIds.length === 0 ? [] : db.select().from(strengthSet).where(inArray(strengthSet.entryId, entryIds)).orderBy(asc(strengthSet.position)).all();
  return entries.map((entry) => ({ entry, sets: sets.filter((set) => set.entryId === entry.id) }));
}

export function updateStrengthSession(db: ObnixeDatabase, env: AgentEnvironment, actor: Actor, input: ToolInput<"update_strength_session">): ToolResult {
  const current = editableSession(db, input.sessionId, "editing");
  if (current.sport !== "strength") throw new ToolInputError(`Session '${current.id}' is a ${current.sport} session. Correct it with update_session.`);
  const plan = planExercises(db, env, input.exercises);
  const timing = completedTiming(current);
  const previous = previousEntries(db, current.id);
  const previousSetIds = previous.flatMap((owner) => owner.sets.map((set) => set.id));
  const anchored: readonly PainReport[] = previousSetIds.length === 0 ? [] : db.select().from(painReport).where(inArray(painReport.strengthSetId, previousSetIds)).all();

  const mutations: Mutation[] = anchored.map((pain): Mutation => ({ kind: "update", table: "pain_report", key: pain.id, patch: { strengthSetId: null } }));
  for (const owner of previous) {
    for (const set of owner.sets) mutations.push({ kind: "delete", table: "strength_set", key: set.id });
    mutations.push({ kind: "delete", table: "strength_entry", key: owner.entry.id });
  }

  const claimed = new Set<Id>();
  const replacedSets = new Map<Id, Id>();
  const totalSets = input.exercises.reduce((total, entry) => total + entry.sets.length, 0);
  let setIndex = 0;
  input.exercises.forEach((entry, position) => {
    const target = resolved(plan, entry.exercise);
    const kept = previous.find((owner) => owner.entry.exerciseId === target.id && !claimed.has(owner.entry.id));
    if (kept !== undefined) claimed.add(kept.entry.id);
    const entryId = env.newId();
    mutations.push({
      kind: "insert",
      table: "strength_entry",
      row: {
        id: entryId,
        sessionId: current.id,
        position,
        exerciseId: target.id,
        programItemId: kept?.entry.programItemId ?? null,
        status: kept?.entry.status === "stopped" ? "stopped" : "done",
        note: entry.note ?? null,
      },
    });
    entry.sets.forEach((set, setPosition) => {
      validateSet(set, target, `Exercise ${position + 1}, set ${setPosition + 1}`);
      const setId = env.newId();
      const before = kept?.sets[setPosition];
      if (before !== undefined) replacedSets.set(before.id, setId);
      mutations.push({
        kind: "insert",
        table: "strength_set",
        row: {
          id: setId,
          entryId,
          position: setPosition,
          loadGrams: set.loadGrams ?? null,
          reps: set.reps ?? null,
          durationSeconds: set.durationSeconds ?? null,
          rir: set.rir ?? null,
          restBeforeSeconds: set.restBeforeSeconds ?? null,
          interrupted: false,
          completedAt: before?.completedAt ?? spread(timing, setIndex, totalSets),
        },
      });
      setIndex += 1;
    });
  });
  for (const pain of anchored) {
    const setId = replacedSets.get(pain.strengthSetId as Id);
    if (setId !== undefined) mutations.push({ kind: "update", table: "pain_report", key: pain.id, patch: { strengthSetId: setId } });
  }

  commitExercises(db, env, actor, plan);
  const summary = `Séance corrigée · ${sessionLabel(current)} · ${plural(input.exercises.length, "exercice", "exercices")}`;
  const changesetId = commit(db, env, { actor, summary, revertsId: null, mutations });
  return { kind: "write", summary, changesetId, data: { sessionId: current.id, localDate: current.localDate, createdExercises: plan.created.map((row) => ({ id: row.id, name: row.name })) } };
}

export function deleteSession(db: ObnixeDatabase, env: AgentEnvironment, actor: Actor, input: ToolInput<"delete_session">): ToolResult {
  const current = editableSession(db, input.sessionId, "deleting");
  const now = env.now();
  const summary = `Séance supprimée · ${sessionLabel(current)}`;
  const changesetId = commit(db, env, { actor, summary, revertsId: null, mutations: [trashMutation("session", current.id, now)] });
  return { kind: "write", summary, changesetId, data: { sessionId: current.id, restorableUntil: new Date(now + trashRetentionMs).toISOString() } };
}

function requireExercise(db: ObnixeDatabase, reference: string): Exercise {
  const found = findExercise(db, reference);
  if (found === undefined) throw new ToolInputError(`No exercise matches '${reference}'. Call list_exercises to see the available names.`);
  return found;
}

function zonesOf(db: ObnixeDatabase, exerciseId: Id): readonly ZoneKey[] {
  return db.select({ zone: exerciseZone.zone }).from(exerciseZone).where(eq(exerciseZone.exerciseId, exerciseId)).all().map((row) => row.zone);
}

function exerciseIssueMessage(issue: ExerciseIssue, current: Exercise): string {
  switch (issue.kind) {
    case "name_missing":
      return "The name must not be empty.";
    case "name_taken":
      return `An exercise named '${issue.existing.name}' already exists (id ${issue.existing.id}). Fold one into the other with merge_exercises.`;
    case "load_step_invalid":
      return "loadStepGrams is not allowed for duration exercises.";
    case "measure_locked":
      return `'${current.name}' is used by logged sessions or programs, so its measure cannot change. Create a new exercise with the right measure instead.`;
    default: {
      const unreachable: never = issue;
      throw new Error(`Unhandled exercise issue ${JSON.stringify(unreachable)}`);
    }
  }
}

function detailInput(current: Exercise, zones: readonly ZoneKey[], input: ToolInput<"update_exercise">): ExerciseInput {
  const measure = input.measure ?? current.measure;
  const keepStep = measure === current.measure || usesLoad(measure);
  const loadStepGrams = input.loadStepGrams !== undefined ? input.loadStepGrams : keepStep ? current.loadStepGrams : null;
  return { name: input.name ?? current.name, measure, equipment: input.equipment ?? current.equipment, loadStepGrams, zones: input.zones ?? zones };
}

function keepZonesReview(mutation: Mutation, current: Exercise): Mutation | null {
  if (mutation.kind !== "update" || mutation.table !== "exercise") return mutation;
  const patch = { ...mutation.patch, zonesReviewed: current.zonesReviewed };
  const changed = (Object.keys(patch) as (keyof typeof patch)[]).some((column) => patch[column] !== current[column]);
  return changed ? { ...mutation, patch } : null;
}

function exerciseSummary(name: string, details: boolean, archived: boolean | undefined): string {
  if (!details && archived === true) return `Exercice archivé · ${name}`;
  if (!details && archived === false) return `Exercice restauré · ${name}`;
  return `Exercice modifié · ${name}`;
}

export function updateExercise(db: ObnixeDatabase, env: AgentEnvironment, actor: Actor, input: ToolInput<"update_exercise">): ToolResult {
  const current = requireExercise(db, input.exercise);
  const zones = zonesOf(db, current.id);
  const next = detailInput(current, zones, input);
  const plan = planUpdateExercise({ exercise: current, zones, inUse: exerciseUsage(db, current.id).inUse, input: next }, db.select().from(exercise).all());
  if (!plan.ok) throw new ToolInputError(exerciseIssueMessage(plan.issue, current));
  const details = input.zones === undefined ? plan.mutations.flatMap((mutation) => keepZonesReview(mutation, current) ?? []) : [...plan.mutations];
  const status = input.archived === undefined ? null : input.archived ? planArchiveExercise(current, env.now()) : planRestoreExercise(current);
  const mutations = status === null ? details : [...details, status];
  if (mutations.length === 0) throw new ToolInputError(`Nothing to change: '${current.name}' already has these values.`);
  const name = next.name.trim().replace(/\s+/g, " ");
  const summary = exerciseSummary(name, details.length > 0, status === null ? undefined : input.archived);
  const changesetId = commit(db, env, { actor, summary, revertsId: null, mutations });
  const saved = requireExercise(db, current.id);
  return {
    kind: "write",
    summary,
    changesetId,
    data: {
      exerciseId: saved.id,
      name: saved.name,
      measure: saved.measure,
      equipment: saved.equipment,
      loadStepGrams: saved.loadStepGrams,
      zones: [...zonesOf(db, saved.id)],
      archived: saved.archivedAt !== null,
    },
  };
}

export function mergeExercises(db: ObnixeDatabase, env: AgentEnvironment, actor: Actor, input: ToolInput<"merge_exercises">): ToolResult {
  const duplicate = requireExercise(db, input.duplicate);
  const target = requireExercise(db, input.target);
  if (duplicate.id === target.id) throw new ToolInputError(`'${input.duplicate}' and '${input.target}' already designate the same exercise '${target.name}'.`);
  if (target.archivedAt !== null) throw new ToolInputError(`The target '${target.name}' is archived. Unarchive it with update_exercise first.`);
  if (duplicate.measure !== target.measure) {
    throw new ToolInputError(`'${duplicate.name}' (${duplicate.measure}) and '${target.name}' (${target.measure}) are measured differently and cannot be merged.`);
  }
  const entries = db.select({ id: strengthEntry.id }).from(strengthEntry).where(eq(strengthEntry.exerciseId, duplicate.id)).all();
  const folded = db.select({ id: exercise.id }).from(exercise).where(eq(exercise.mergedIntoId, duplicate.id)).all();
  const targetZones = new Set(zonesOf(db, target.id));
  const mutations: Mutation[] = [
    ...entries.map((entry): Mutation => ({ kind: "update", table: "strength_entry", key: entry.id, patch: { exerciseId: target.id } })),
    ...folded.map((row): Mutation => ({ kind: "update", table: "exercise", key: row.id, patch: { mergedIntoId: target.id } })),
    ...zonesOf(db, duplicate.id)
      .filter((zone) => !targetZones.has(zone))
      .map((zone): Mutation => ({ kind: "insert", table: "exercise_zone", row: { exerciseId: target.id, zone } })),
    { kind: "update", table: "exercise", key: duplicate.id, patch: { mergedIntoId: target.id, archivedAt: duplicate.archivedAt ?? env.now() } },
  ];
  const summary = `Exercices fusionnés · ${duplicate.name} dans ${target.name}`;
  const changesetId = commit(db, env, { actor, summary, revertsId: null, mutations });
  return { kind: "write", summary, changesetId, data: { targetId: target.id, target: target.name, duplicateId: duplicate.id, movedEntries: entries.length } };
}

function programName(db: ObnixeDatabase, programId: Id): string {
  return latestVersion(db, programId)?.name ?? programId;
}

function statusRefusalMessage(refusal: StatusRefusal, programId: string, name: string): string {
  switch (refusal) {
    case "not_found":
      return `No program with id '${programId}'. Call list_programs to see the available ids.`;
    case "already_active":
      return `'${name}' is already the active program.`;
    case "already_archived":
      return `'${name}' is already archived.`;
    default: {
      const unreachable: never = refusal;
      throw new Error(`Unhandled status refusal ${String(unreachable)}`);
    }
  }
}

export function setProgramStatus(db: ObnixeDatabase, env: AgentEnvironment, actor: Actor, input: ToolInput<"set_program_status">): ToolResult {
  const programs = db.select().from(program).all();
  const target = programs.find((row) => row.id === input.programId);
  const plan = target === undefined ? ({ ok: false, refusal: "not_found" } as const) : input.status === "active" ? planActivate(programs, target.id) : planArchive(target);
  const name = target === undefined ? input.programId : programName(db, target.id);
  if (!plan.ok) throw new ToolInputError(statusRefusalMessage(plan.refusal, input.programId, name));
  const archivedOther = input.status === "active" && plan.archived !== null ? plan.archived : null;
  const summary =
    input.status === "archived" ? `Programme archivé · ${name}` : archivedOther === null ? `Programme activé · ${name}` : `Programme activé · ${name}, ${programName(db, archivedOther.id)} archivé`;
  const changesetId = commit(db, env, { actor, summary, revertsId: null, mutations: plan.mutations });
  return { kind: "write", summary, changesetId, data: { programId: input.programId, status: input.status, archivedProgramId: archivedOther?.id ?? null } };
}
