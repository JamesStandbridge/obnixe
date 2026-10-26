import { desc, eq } from "drizzle-orm";
import { exerciseNameKey, program, programItem, programSlot, programVariant, programVersion, sports } from "@obnixe/schema";
import type { EpochMs, ExerciseMeasure, FieldValues, Id, LocalDate, ProgramVersion } from "@obnixe/schema";
import type { ObnixeDatabase } from "../database.ts";
import { commit } from "../writer.ts";
import type { Actor, Mutation, NewRow } from "../writer.ts";
import type { ToolInput } from "./contract.ts";
import type { AgentEnvironment, ToolResult } from "./environment.ts";
import { ToolInputError } from "./environment.ts";
import { findExercise, newExerciseRow, planExercises } from "./exercises.ts";
import type { ExercisePlan, ResolvedExercise } from "./exercises.ts";
import { frenchDay, frenchDistance, frenchDuration, plural } from "./format.ts";

export const futureToleranceMs = 5 * 60_000;

export function commitExercises(db: ObnixeDatabase, env: AgentEnvironment, actor: Actor, plan: ExercisePlan): void {
  if (plan.created.length === 0) return;
  const names = plan.created.map((row) => row.name).join(", ");
  const summary = plan.created.length === 1 ? `Exercice ajouté · ${names}` : `Exercices ajoutés · ${names}`;
  commit(db, env, { actor, summary, revertsId: null, mutations: createdExerciseInserts(plan) });
}

export function createdExerciseInserts(plan: ExercisePlan): Mutation[] {
  return plan.created.map((row): Mutation => ({ kind: "insert", table: "exercise", row }));
}

export function resolved(plan: ExercisePlan, reference: string): ResolvedExercise {
  const found = plan.resolved.get(reference);
  if (found === undefined) throw new Error(`Exercise '${reference}' was not planned`);
  return found;
}

export function createExercise(db: ObnixeDatabase, env: AgentEnvironment, actor: Actor, input: ToolInput<"create_exercise">): ToolResult {
  const name = input.name.replace(/\s+/g, " ");
  const existing = findExercise(db, name);
  if (existing !== undefined && existing.nameKey === exerciseNameKey(name)) {
    throw new ToolInputError(`An exercise named '${existing.name}' already exists (id ${existing.id}).`);
  }
  if (input.measure === "duration" && input.loadStepGrams !== undefined) throw new ToolInputError("loadStepGrams is not allowed for duration exercises.");
  const row = { ...newExerciseRow(env, name, input, input.loadStepGrams ?? null), zonesReviewed: input.zones !== undefined };
  const zoneKeys = [...new Set(input.zones ?? [])];
  const mutations: Mutation[] = [
    { kind: "insert", table: "exercise", row },
    ...zoneKeys.map((zone): Mutation => ({ kind: "insert", table: "exercise_zone", row: { exerciseId: row.id, zone } })),
  ];
  const summary = `Exercice · ${name}`;
  const changesetId = commit(db, env, { actor, summary, revertsId: null, mutations });
  return { kind: "write", summary, changesetId, data: { exerciseId: row.id, name } };
}

type SlotInput = ToolInput<"upsert_program">["slots"][number];
type ItemInput = SlotInput["variants"][number]["items"][number];

interface LineageIndex {
  readonly slots: ReadonlySet<string>;
  readonly variants: ReadonlySet<string>;
  readonly items: ReadonlySet<string>;
}

function lineageIndex(db: ObnixeDatabase, version: ProgramVersion | undefined): LineageIndex {
  const slots = new Set<string>();
  const variants = new Set<string>();
  const items = new Set<string>();
  if (version === undefined) return { slots, variants, items };
  for (const slot of db.select().from(programSlot).where(eq(programSlot.versionId, version.id)).all()) {
    slots.add(slot.lineageId);
    for (const variant of db.select().from(programVariant).where(eq(programVariant.slotId, slot.id)).all()) {
      variants.add(`${slot.lineageId}/${variant.lineageId}`);
      for (const item of db.select().from(programItem).where(eq(programItem.variantId, variant.id)).all()) {
        items.add(`${slot.lineageId}/${variant.lineageId}/${item.lineageId}`);
      }
    }
  }
  return { slots, variants, items };
}

function claimLineage(given: string | undefined, known: ReadonlySet<string>, scope: string, used: Set<string>, label: string, env: AgentEnvironment): Id {
  if (given === undefined) return env.newId();
  const path = scope === "" ? given : `${scope}/${given}`;
  if (!known.has(path)) throw new ToolInputError(`Unknown ${label} lineageId '${given}'. Reuse a lineageId from get_program or omit it for a new ${label}.`);
  if (used.has(path)) throw new ToolInputError(`The ${label} lineageId '${given}' is used twice.`);
  used.add(path);
  return given as Id;
}

function validateItem(item: ItemInput, measure: ExerciseMeasure, where: string): void {
  const hasReps = item.repsMin !== undefined || item.repsMax !== undefined;
  const hasDuration = item.durationMinSeconds !== undefined || item.durationMaxSeconds !== undefined;
  if (measure === "duration") {
    if (hasReps || item.durationMinSeconds === undefined || item.durationMaxSeconds === undefined) {
      throw new ToolInputError(`${where}: '${item.exercise}' is a duration exercise, give durationMinSeconds and durationMaxSeconds only.`);
    }
    if (item.durationMaxSeconds < item.durationMinSeconds) throw new ToolInputError(`${where}: durationMaxSeconds must be >= durationMinSeconds.`);
    return;
  }
  if (hasDuration || item.repsMin === undefined || item.repsMax === undefined) {
    throw new ToolInputError(`${where}: '${item.exercise}' is counted in reps, give repsMin and repsMax only.`);
  }
  if (item.repsMax < item.repsMin) throw new ToolInputError(`${where}: repsMax must be >= repsMin.`);
}

export function upsertProgram(db: ObnixeDatabase, env: AgentEnvironment, actor: Actor, input: ToolInput<"upsert_program">): ToolResult {
  const existing = input.programId === undefined ? undefined : db.select().from(program).where(eq(program.id, input.programId as Id)).get();
  if (input.programId !== undefined && existing === undefined) throw new ToolInputError(`No program with id '${input.programId}'. Omit programId to create a program.`);
  const latest = existing === undefined ? undefined : db.select().from(programVersion).where(eq(programVersion.programId, existing.id)).orderBy(desc(programVersion.number)).get();
  const known = lineageIndex(db, latest);
  const plan = planExercises(db, env, input.slots.flatMap((slot) => slot.variants.flatMap((variant) => variant.items)));

  const programId = existing?.id ?? env.newId();
  const versionId = env.newId();
  const number = (latest?.number ?? 0) + 1;
  const mutations: Mutation[] = [];
  if (existing === undefined) mutations.push({ kind: "insert", table: "program", row: { id: programId, status: "draft" } });
  mutations.push({
    kind: "insert",
    table: "program_version",
    row: { id: versionId, programId, number, name: input.name, sessionsPerWeek: input.sessionsPerWeek, copiedFromId: latest?.id ?? null, summary: input.summary, reason: input.reason ?? null },
  });

  const usedSlots = new Set<string>();
  const usedVariants = new Set<string>();
  const usedItems = new Set<string>();
  input.slots.forEach((slot, slotPosition) => {
    const where = `Slot ${slotPosition + 1} (${slot.name})`;
    if (slot.sport === "strength" && slot.variants.length === 0) throw new ToolInputError(`${where}: strength slots need at least one variant with exercises.`);
    if (slot.sport !== "strength" && slot.variants.length > 0) throw new ToolInputError(`${where}: only strength slots have variants.`);
    const slotLineage = claimLineage(slot.lineageId, known.slots, "", usedSlots, "slot", env);
    const slotId = env.newId();
    const slotRow: NewRow<"program_slot"> = {
      id: slotId,
      versionId,
      lineageId: slotLineage,
      position: slotPosition,
      sport: slot.sport,
      name: slot.name,
      targetDurationSeconds: slot.targetDurationSeconds ?? null,
      targetEffort: slot.targetEffort ?? null,
      targetValues: slot.targetValues ?? {},
    };
    mutations.push({ kind: "insert", table: "program_slot", row: slotRow });
    slot.variants.forEach((variant, variantPosition) => {
      const variantLineage = claimLineage(variant.lineageId, known.variants, slotLineage, usedVariants, "variant", env);
      const variantId = env.newId();
      mutations.push({ kind: "insert", table: "program_variant", row: { id: variantId, slotId, lineageId: variantLineage, position: variantPosition, name: variant.name } });
      variant.items.forEach((item, itemPosition) => {
        const target = resolved(plan, item.exercise);
        validateItem(item, target.measure, `${where}, ${variant.name}, item ${itemPosition + 1}`);
        const itemRow: NewRow<"program_item"> = {
          id: env.newId(),
          variantId,
          lineageId: claimLineage(item.lineageId, known.items, `${slotLineage}/${variantLineage}`, usedItems, "item", env),
          position: itemPosition,
          exerciseId: target.id,
          sets: item.sets,
          repsMin: item.repsMin ?? null,
          repsMax: item.repsMax ?? null,
          durationMinSeconds: item.durationMinSeconds ?? null,
          durationMaxSeconds: item.durationMaxSeconds ?? null,
          targetRir: item.targetRir ?? null,
          restSeconds: item.restSeconds ?? null,
          restAfterSeconds: item.restAfterSeconds ?? null,
        };
        mutations.push({ kind: "insert", table: "program_item", row: itemRow });
      });
    });
  });

  commitExercises(db, env, actor, plan);
  const changesetId = commit(db, env, { actor, summary: input.summary, revertsId: null, mutations });
  return {
    kind: "write",
    summary: input.summary,
    changesetId,
    data: { programId, versionId, versionNumber: number, status: existing?.status ?? "draft", createdExercises: plan.created.map((row) => ({ id: row.id, name: row.name })) },
  };
}

export interface SessionTiming {
  readonly startedAt: EpochMs;
  readonly endedAt: EpochMs;
  readonly localDate: LocalDate;
}

function sessionTiming(env: AgentEnvironment, startedAt: string, durationSeconds: number): SessionTiming {
  const start = Date.parse(startedAt);
  const end = start + durationSeconds * 1000;
  if (end > env.now() + futureToleranceMs) throw new ToolInputError("The session must be finished: startedAt + durationSeconds is in the future.");
  return { startedAt: start as EpochMs, endedAt: end as EpochMs, localDate: startedAt.slice(0, 10) as LocalDate };
}

interface SessionExtras {
  readonly effort?: NewRow<"session">["effort"] | undefined;
  readonly sensation?: NewRow<"session">["sensation"] | undefined;
  readonly enjoyment?: number | undefined;
  readonly title?: string | undefined;
  readonly note?: string | undefined;
}

function sessionRow(env: AgentEnvironment, sport: NewRow<"session">["sport"], timing: SessionTiming, values: FieldValues, extras: SessionExtras): NewRow<"session"> {
  return {
    id: env.newId(),
    sport,
    slotId: null,
    variantId: null,
    countsInRotation: false,
    gearId: null,
    title: extras.title ?? null,
    status: "completed",
    startedAt: timing.startedAt,
    endedAt: timing.endedAt,
    pausedSeconds: 0,
    localDate: timing.localDate,
    timeZone: env.timeZone,
    values,
    effort: extras.effort ?? null,
    sensation: extras.sensation ?? null,
    enjoyment: extras.enjoyment ?? null,
    note: extras.note ?? null,
    review: "skipped",
    deletedAt: null,
  };
}

export function spread(timing: SessionTiming, index: number, count: number): EpochMs {
  return Math.round(timing.startedAt + ((timing.endedAt - timing.startedAt) * (index + 1)) / (count + 1)) as EpochMs;
}

function activityHeadline(input: ToolInput<"log_activity">, values: FieldValues): string {
  const distance = values.distance;
  if (typeof distance === "number" && distance > 0) return frenchDistance(distance);
  const items = input.items ?? [];
  if (items.length > 0) {
    if (input.sport === "climb") {
      const discipline = values.discipline;
      return discipline === "boulder" || discipline === "board" ? plural(items.length, "bloc", "blocs") : plural(items.length, "voie", "voies");
    }
    return plural(items.length, "entrée", "entrées");
  }
  return frenchDuration(input.durationSeconds);
}

export function logActivity(db: ObnixeDatabase, env: AgentEnvironment, actor: Actor, input: ToolInput<"log_activity">): ToolResult {
  const sport = sports[input.sport];
  const items = input.items ?? [];
  if (items.length > 0 && sport.archetype !== "itemized") throw new ToolInputError(`${input.sport} sessions have no items; put everything in 'values'.`);
  const timing = sessionTiming(env, input.startedAt, input.durationSeconds);
  const values = input.values ?? {};
  const row = sessionRow(env, input.sport, timing, values, input);
  const mutations: Mutation[] = [
    { kind: "insert", table: "session", row },
    ...items.map(
      (item, position): Mutation => ({ kind: "insert", table: "session_item", row: { id: env.newId(), sessionId: row.id, position, values: item, recordedAt: spread(timing, position, items.length) } }),
    ),
  ];
  const summary = `${sport.label} du ${frenchDay(timing.localDate)} · ${activityHeadline(input, values)}`;
  const changesetId = commit(db, env, { actor, summary, revertsId: null, mutations });
  return { kind: "write", summary, changesetId, data: { sessionId: row.id, localDate: timing.localDate } };
}

export type StrengthSetInput = ToolInput<"log_strength_session">["exercises"][number]["sets"][number];

export function validateSet(set: StrengthSetInput, target: ResolvedExercise, where: string): void {
  switch (target.measure) {
    case "load_reps":
      if (set.reps === undefined || set.loadGrams === undefined || set.durationSeconds !== undefined) throw new ToolInputError(`${where}: '${target.name}' needs loadGrams and reps.`);
      return;
    case "bodyweight_reps":
      if (set.reps === undefined || set.durationSeconds !== undefined) throw new ToolInputError(`${where}: '${target.name}' needs reps (loadGrams optional for added load).`);
      return;
    case "duration":
      if (set.durationSeconds === undefined || set.reps !== undefined) throw new ToolInputError(`${where}: '${target.name}' needs durationSeconds and no reps.`);
      return;
    default: {
      const unreachable: never = target.measure;
      throw new Error(`Unhandled measure ${String(unreachable)}`);
    }
  }
}

export function logStrengthSession(db: ObnixeDatabase, env: AgentEnvironment, actor: Actor, input: ToolInput<"log_strength_session">): ToolResult {
  const timing = sessionTiming(env, input.startedAt, input.durationSeconds);
  const plan = planExercises(db, env, input.exercises);
  const row = sessionRow(env, "strength", timing, {}, input);
  const mutations: Mutation[] = [...createdExerciseInserts(plan), { kind: "insert", table: "session", row }];
  const totalSets = input.exercises.reduce((total, entry) => total + entry.sets.length, 0);
  let setIndex = 0;
  input.exercises.forEach((entry, position) => {
    const target = resolved(plan, entry.exercise);
    const entryId = env.newId();
    mutations.push({ kind: "insert", table: "strength_entry", row: { id: entryId, sessionId: row.id, position, exerciseId: target.id, programItemId: null, status: "done", note: entry.note ?? null } });
    entry.sets.forEach((set, setPosition) => {
      validateSet(set, target, `Exercise ${position + 1}, set ${setPosition + 1}`);
      mutations.push({
        kind: "insert",
        table: "strength_set",
        row: {
          id: env.newId(),
          entryId,
          position: setPosition,
          loadGrams: set.loadGrams ?? null,
          reps: set.reps ?? null,
          durationSeconds: set.durationSeconds ?? null,
          rir: set.rir ?? null,
          restBeforeSeconds: set.restBeforeSeconds ?? null,
          interrupted: false,
          completedAt: spread(timing, setIndex, totalSets),
        },
      });
      setIndex += 1;
    });
  });
  const summary = `${sports.strength.label} du ${frenchDay(timing.localDate)} · ${plural(input.exercises.length, "exercice", "exercices")}`;
  const changesetId = commit(db, env, { actor, summary, revertsId: null, mutations });
  return { kind: "write", summary, changesetId, data: { sessionId: row.id, localDate: timing.localDate, createdExercises: plan.created.map((created) => ({ id: created.id, name: created.name })) } };
}
