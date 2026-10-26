import { asc, eq, inArray } from "drizzle-orm";
import { exercise, programItem, settings, sports, zones } from "@obnixe/schema";
import type { EpochMs, Exercise, Id, MassUnit, PainReport, ProgramItem, ProgramSlot, ProgramVariant, ZoneKey } from "@obnixe/schema";
import type { ObnixeDatabase } from "../database.ts";
import { addDays, daysBetween, localDateOf, mondayOf } from "../dates.ts";
import { trackedZones } from "../activity/pain.ts";
import { exerciseZones, lastSessionBySlotLineage, latestZonePain, worstPain, zonePainWindowMs } from "../programs/queries.ts";
import type { LatestZonePain } from "../programs/queries.ts";
import { currentProgram, nextSlot } from "../rotation.ts";
import { todayCheckIn } from "../stats/checkin.ts";
import { completedSessions } from "../stats/sessions.ts";
import { estimatedSlotSeconds, openSession } from "../stats/today.ts";
import type { OpenSession } from "../stats/today.ts";
import { weekSummary } from "../stats/week.ts";
import { latestPainByZone, painfulZones } from "../training/pain.ts";
import { previousPerformance, suggestProgression } from "../training/progression.ts";
import { stepGramsFor } from "../training/units.ts";
import { targetFor } from "../training/workout.ts";
import type { AgentEnvironment, Json, ToolResult } from "./environment.ts";

interface PainContext {
  readonly recent: ReadonlyMap<ZoneKey, LatestZonePain>;
  readonly latest: ReadonlyMap<ZoneKey, PainReport>;
  readonly zonesByExercise: ReadonlyMap<Id, readonly ZoneKey[]>;
}

interface PlanningContext {
  readonly db: ObnixeDatabase;
  readonly env: AgentEnvironment;
  readonly massUnit: MassUnit;
  readonly open: OpenSession | null;
  readonly pain: PainContext;
}

function iso(epochMs: number | null): string | null {
  return epochMs === null ? null : new Date(epochMs).toISOString();
}

function painJson(context: PlanningContext, pain: LatestZonePain | null): Json {
  if (pain === null) return null;
  return { zone: pain.zone, zoneLabel: zones[pain.zone].label, level: pain.level, localDate: localDateOf(pain.occurredAt, context.env.timeZone) };
}

function openJson(open: OpenSession | null): Json {
  if (open === null) return null;
  return {
    sessionId: open.session.id,
    sport: open.session.sport,
    status: open.session.status,
    slotName: open.slotName,
    variantName: open.variantName,
    startedAt: iso(open.session.startedAt),
    lastActivityAt: iso(open.lastActivityAt),
    setCount: open.setCount,
    itemCount: open.itemCount,
  };
}

function exerciseJson(context: PlanningContext, item: ProgramItem, row: Exercise): Json {
  const loaded = context.pain.zonesByExercise.get(row.id) ?? [];
  const target = targetFor(item);
  const previous = previousPerformance(context.db, { exerciseId: row.id, itemLineageId: item.lineageId, before: context.env.now(), excludeSessionId: context.open?.session.id ?? null });
  const progression = suggestProgression({
    measure: row.measure,
    target,
    stepGrams: stepGramsFor(row, context.massUnit),
    previous: previous?.sets ?? [],
    painful: painfulZones(loaded, context.pain.latest).length > 0,
  });
  return {
    exerciseId: row.id,
    name: row.name,
    measure: row.measure,
    equipment: row.equipment,
    itemLineageId: item.lineageId,
    sets: item.sets,
    repsMin: item.repsMin,
    repsMax: item.repsMax,
    durationMinSeconds: item.durationMinSeconds,
    durationMaxSeconds: item.durationMaxSeconds,
    targetRir: item.targetRir,
    restSeconds: target.restSeconds,
    restAfterSeconds: target.restAfterSeconds,
    zones: [...loaded],
    pain: painJson(context, worstPain(loaded, context.pain.recent)),
    lastPerformance:
      previous === null
        ? null
        : {
            sessionId: previous.sessionId,
            localDate: previous.localDate,
            sets: previous.sets.map((set) => ({ loadGrams: set.loadGrams, reps: set.reps, durationSeconds: set.durationSeconds, rir: set.rir, interrupted: set.interrupted })),
          },
    suggestion: {
      kind: progression.kind,
      topReached: progression.topReached,
      sets: progression.sets.map((set) => ({ loadGrams: set.loadGrams, reps: set.reps, durationSeconds: set.durationSeconds })),
    },
  };
}

interface VariantPlan {
  readonly json: Json;
  readonly zones: readonly ZoneKey[];
}

function planVariant(context: PlanningContext, slot: ProgramSlot, variant: ProgramVariant, isDefault: boolean): VariantPlan {
  const items = context.db.select().from(programItem).where(eq(programItem.variantId, variant.id)).orderBy(asc(programItem.position)).all();
  const exerciseIds = [...new Set(items.map((item) => item.exerciseId))];
  const exercises = new Map((exerciseIds.length === 0 ? [] : context.db.select().from(exercise).where(inArray(exercise.id, exerciseIds)).all()).map((row) => [row.id, row]));
  const exercisesJson = items.flatMap((item) => {
    const row = exercises.get(item.exerciseId);
    return row === undefined ? [] : [exerciseJson(context, item, row)];
  });
  return {
    json: { lineageId: variant.lineageId, name: variant.name, isDefault, estimatedDurationSeconds: estimatedSlotSeconds(slot, items), exercises: exercisesJson },
    zones: exerciseIds.flatMap((id) => context.pain.zonesByExercise.get(id) ?? []),
  };
}

export function getNextSession(db: ObnixeDatabase, env: AgentEnvironment): ToolResult {
  const now = env.now();
  const today = localDateOf(now, env.timeZone);
  const open = openSession(db);
  const checkIn = todayCheckIn(db, today).checkIn;
  const base = { today, openSession: openJson(open), checkIn: checkIn === null ? null : { energy: checkIn.energy, sleep: checkIn.sleep } };
  const current = currentProgram(db);
  if (current === null) return { kind: "read", summary: "Prochaine séance", data: { ...base, program: null, week: null, next: null, after: null, painOnLoadedZones: [] } };

  const monday = mondayOf(today);
  const week = weekSummary(today, completedSessions(db, { from: monday, to: addDays(monday, 6) }), current.version.sessionsPerWeek);
  const program = { id: current.program.id, name: current.version.name, versionNumber: current.version.number, sessionsPerWeek: current.version.sessionsPerWeek };
  const weekJson = { monday, sessionsDone: week.sessionsDone, sessionsPlanned: week.sessionsPlanned, today: week.days.find((day) => day.isToday)?.state ?? "rest" };
  const next = nextSlot(db);
  if (next === null) return { kind: "read", summary: "Aucune séance prévue", data: { ...base, program, week: weekJson, next: null, after: null, painOnLoadedZones: [] } };

  const context: PlanningContext = {
    db,
    env,
    massUnit: db.select({ massUnit: settings.massUnit }).from(settings).get()?.massUnit ?? "kg",
    open,
    pain: { recent: latestZonePain(db, (now - zonePainWindowMs) as EpochMs), latest: latestPainByZone(db, now), zonesByExercise: exerciseZones(db) },
  };
  const variants = next.variants.map((variant, index) => planVariant(context, next.slot, variant, index === 0));
  const lastDoneAt = lastSessionBySlotLineage(db, current.program.id).get(next.slot.lineageId);
  const lastDoneOn = lastDoneAt === undefined ? null : localDateOf(lastDoneAt, env.timeZone);
  const tracked = new Set(trackedZones(db));
  const loadedZones = [...new Set(variants.flatMap((variant) => variant.zones))];
  const painOnLoadedZones = loadedZones.flatMap((zone) => {
    const pain = context.pain.recent.get(zone);
    return pain === undefined ? [] : [{ zone, zoneLabel: zones[zone].label, level: pain.level, localDate: localDateOf(pain.occurredAt, env.timeZone), followed: tracked.has(zone) }];
  });
  const slot = next.slot;
  return {
    kind: "read",
    summary: `Prochaine séance · ${slot.name}`,
    data: {
      ...base,
      program,
      week: weekJson,
      next: {
        lineageId: slot.lineageId,
        name: slot.name,
        sport: slot.sport,
        sportLabel: sports[slot.sport].label,
        targetDurationSeconds: slot.targetDurationSeconds,
        targetEffort: slot.targetEffort,
        targetValues: slot.targetValues,
        lastCompletedOn: lastDoneOn,
        daysSinceLastCompleted: lastDoneOn === null ? null : daysBetween(lastDoneOn, today),
        variants: variants.map((variant) => variant.json),
      },
      after: next.after === null ? null : { lineageId: next.after.lineageId, name: next.after.name, sport: next.after.sport },
      painOnLoadedZones,
    },
  };
}
