import { gramsToMass, latestPainByZone, loadWorkout, painfulZones, previousFor, stepGramsFor, suggestProgression, trackedZones } from "@obnixe/core";
import type { PerformedSet, PreviousPerformance, Progression, SetDraft, WorkoutData, WorkoutExercise } from "@obnixe/core";
import type { EpochMs, Id, MassUnit, PainReport, ZoneKey } from "@obnixe/schema";
import { db } from "@/data/database";
import { formatMass } from "@/features/training/format";
import { formatClock } from "@/format/durations";
import { formatSigned } from "@/format/numbers";
import { lowerFirst, zoneLabel } from "@/format/labels";

export interface LiveWorkout {
  readonly data: WorkoutData;
  readonly previous: ReadonlyMap<Id, PreviousPerformance | null>;
  readonly latestPains: ReadonlyMap<ZoneKey, PainReport>;
  readonly tracked: readonly ZoneKey[];
}

const endOfTime = Number.MAX_SAFE_INTEGER as EpochMs;

export function loadLiveWorkout(sessionId: Id): LiveWorkout | null {
  const data = loadWorkout(db(), sessionId);
  if (data === null) return null;
  return {
    data,
    previous: new Map(data.exercises.map((target) => [target.entry.id, previousFor(db(), data, target, data.session.startedAt)])),
    latestPains: latestPainByZone(db(), endOfTime),
    tracked: trackedZones(db()),
  };
}

export const loadLimits = { kg: 400, lb: 880 } as const;
export const repsLimit = 60;
export const durationLimit = 3600;

export function liveProgression(live: LiveWorkout, target: WorkoutExercise, unit: MassUnit): Progression {
  return suggestProgression({
    measure: target.exercise.measure,
    target: target.target,
    stepGrams: stepGramsFor(target.exercise, unit),
    previous: live.previous.get(target.entry.id)?.sets ?? [],
    painful: painfulZones(target.zones, live.latestPains).length > 0,
  });
}

export interface Draft {
  readonly loadGrams: number | null;
  readonly reps: number | null;
  readonly durationSeconds: number | null;
  readonly rir: number | null;
}

export function isDraftValid(target: WorkoutExercise, draft: Draft): boolean {
  switch (target.exercise.measure) {
    case "load_reps":
      return draft.loadGrams !== null && (draft.reps ?? 0) > 0;
    case "bodyweight_reps":
      return (draft.reps ?? 0) > 0;
    case "duration":
      return (draft.durationSeconds ?? 0) > 0;
    default: {
      const unreachable: never = target.exercise.measure;
      return unreachable;
    }
  }
}

export function setText(set: Pick<PerformedSet, "loadGrams" | "reps" | "durationSeconds">, unit: MassUnit): string {
  if (set.durationSeconds !== null) return formatClock(set.durationSeconds);
  if (set.loadGrams !== null && set.loadGrams > 0) return `${formatMass(set.loadGrams, unit)} × ${set.reps ?? 0}`;
  return `${set.reps ?? 0} rép.`;
}

export function targetText(target: WorkoutExercise): string {
  const { sets, repsMin, repsMax, durationMinSeconds, durationMaxSeconds } = target.target;
  if (durationMinSeconds !== null && durationMaxSeconds !== null) {
    return durationMinSeconds === durationMaxSeconds ? `${sets} × ${durationMinSeconds} s` : `${sets} × ${durationMinSeconds}–${durationMaxSeconds} s`;
  }
  if (repsMin === null || repsMax === null) return `${sets} séries`;
  return repsMin === repsMax ? `${sets} × ${repsMin}` : `${sets} × ${repsMin}–${repsMax}`;
}

export function rangeText(target: WorkoutExercise): string {
  const { repsMin, repsMax, durationMinSeconds, durationMaxSeconds } = target.target;
  if (durationMinSeconds !== null && durationMaxSeconds !== null) return durationMinSeconds === durationMaxSeconds ? `${durationMinSeconds}` : `${durationMinSeconds}–${durationMaxSeconds}`;
  if (repsMin === null || repsMax === null) return "";
  return repsMin === repsMax ? `${repsMin}` : `${repsMin}–${repsMax}`;
}

export interface Comparison {
  readonly mark: "discomfort" | "stop" | null;
  readonly lead: string;
  readonly previous: string | null;
}

interface ComparisonRequest {
  readonly target: WorkoutExercise;
  readonly progression: Progression;
  readonly previous: PerformedSet | null;
  readonly draft: Draft;
  readonly base: SetDraft;
  readonly setIndex: number;
  readonly editing: boolean;
  readonly unit: MassUnit;
  readonly stepGrams: number;
  readonly latestPains: ReadonlyMap<ZoneKey, PainReport>;
}

function sameValues(a: Pick<Draft, "loadGrams" | "reps" | "durationSeconds">, b: Pick<Draft, "loadGrams" | "reps" | "durationSeconds">): boolean {
  return a.loadGrams === b.loadGrams && a.reps === b.reps && a.durationSeconds === b.durationSeconds;
}

export function describeComparison(request: ComparisonRequest): Comparison {
  const { previous, draft, unit, progression } = request;
  if (previous === null) return { mark: null, lead: "Première fois", previous: null };
  const previousText = `préc. ${setText(previous, unit)}${previous.rir === null ? "" : ` · RIR ${previous.rir >= 4 ? "4+" : previous.rir}`}`;
  const untouchedFirst = !request.editing && request.setIndex === 0 && request.base.suggested && sameValues(draft, request.base);
  if (untouchedFirst && progression.kind === "increase_load") {
    return { mark: null, lead: `Haut de fourchette : +${formatMass(request.stepGrams, unit)} ${unit}`, previous: previousText };
  }
  if (untouchedFirst && progression.kind === "suspended") {
    const painful = painfulZones(request.target.zones, request.latestPains);
    const mark = painful.some((zone) => request.latestPains.get(zone)?.level === "stop") ? "stop" : "discomfort";
    return { mark, lead: `Progression suspendue · ${painful.map((zone) => lowerFirst(zoneLabel(zone))).join(", ")}`, previous: previousText };
  }
  const parts: string[] = [];
  if (draft.loadGrams !== null && previous.loadGrams !== null) {
    const delta = Math.round((gramsToMass(draft.loadGrams, unit) - gramsToMass(previous.loadGrams, unit)) * 10) / 10;
    if (delta !== 0) parts.push(`${formatSigned(delta)} ${unit}`);
  }
  if (draft.reps !== null && previous.reps !== null && draft.reps !== previous.reps) parts.push(`${formatSigned(draft.reps - previous.reps, 0)} rép.`);
  if (draft.durationSeconds !== null && previous.durationSeconds !== null && draft.durationSeconds !== previous.durationSeconds) {
    parts.push(`${formatSigned(draft.durationSeconds - previous.durationSeconds, 0)} s`);
  }
  return { mark: null, lead: parts.length === 0 ? "Comme la dernière fois" : parts.join(" · "), previous: previousText };
}