import { workoutLimits, workoutPlanSchemaFor, workoutStepCount } from "@obnixe/schema";
import type { RecordingProfile, WorkoutDuration, WorkoutNode, WorkoutPlan, WorkoutRepeat, WorkoutStep, WorkoutTarget } from "@obnixe/schema";

export type Measure = RecordingProfile["primary"];

/** A step of the plan: a top-level node, or the step of a repeat when `step` is set. */
export interface StepPath {
  readonly node: number;
  readonly step: number | null;
}

export type DurationKind = WorkoutDuration["kind"];
export type TargetKind = WorkoutTarget["kind"];

function step(intent: WorkoutStep["intent"], duration: WorkoutDuration, target: WorkoutTarget = { kind: "none" }): WorkoutStep {
  return { type: "step", intent, duration, target, label: null };
}

const minutes = (count: number): WorkoutDuration => ({ kind: "time", ms: count * 60_000 });
const meters = (count: number): WorkoutDuration => ({ kind: "distance", mm: count * 1000 });

function defaultRepeat(measure: Measure): WorkoutRepeat {
  switch (measure) {
    case "pace":
      return { type: "repeat", count: 6, steps: [step("work", meters(1000)), step("recovery", minutes(2))] };
    case "speed":
      return { type: "repeat", count: 6, steps: [step("work", minutes(5)), step("recovery", minutes(3))] };
    default: {
      const unreachable: never = measure;
      throw new Error(`Unhandled measure ${JSON.stringify(unreachable)}`);
    }
  }
}

/** The intervals a new guided workout starts from: « 15 min · 8 × (400 m Z4 · 1:30 récup) · 10 min » on foot. */
export function defaultWorkout(measure: Measure): WorkoutPlan {
  const zone4: WorkoutTarget = { kind: "heart_rate_zone", zone: 4 };
  const repeat: WorkoutRepeat =
    measure === "pace"
      ? { type: "repeat", count: 8, steps: [step("work", meters(400), zone4), step("recovery", { kind: "time", ms: 90_000 })] }
      : { type: "repeat", count: 6, steps: [step("work", minutes(5), zone4), step("recovery", minutes(3))] };
  return { version: 1, nodes: [step("warmup", minutes(15)), repeat, step("cooldown", minutes(10))] };
}

export function appendStep(plan: WorkoutPlan): WorkoutPlan {
  return { ...plan, nodes: [...plan.nodes, step(plan.nodes.length === 0 ? "warmup" : "cooldown", minutes(10))] };
}

export function appendRepeat(plan: WorkoutPlan, measure: Measure): WorkoutPlan {
  return { ...plan, nodes: [...plan.nodes, defaultRepeat(measure)] };
}

export function stepAt(plan: WorkoutPlan, path: StepPath): WorkoutStep | null {
  const node = plan.nodes[path.node];
  if (node === undefined) return null;
  if (path.step === null) return node.type === "step" ? node : null;
  return node.type === "repeat" ? (node.steps[path.step] ?? null) : null;
}

function withNode(plan: WorkoutPlan, index: number, update: (node: WorkoutNode) => readonly WorkoutNode[]): WorkoutPlan {
  return { ...plan, nodes: plan.nodes.flatMap((node, position) => (position === index ? update(node) : [node])) };
}

function moved<T>(items: readonly T[], index: number, offset: number): readonly T[] {
  const target = index + offset;
  const item = items[index];
  if (item === undefined || target < 0 || target >= items.length) return items;
  const next = items.filter((_, position) => position !== index);
  next.splice(target, 0, item);
  return next;
}

export function replaceStep(plan: WorkoutPlan, path: StepPath, next: WorkoutStep): WorkoutPlan {
  return withNode(plan, path.node, (node) => {
    if (path.step === null) return [next];
    return node.type === "repeat" ? [{ ...node, steps: node.steps.map((entry, position) => (position === path.step ? next : entry)) }] : [node];
  });
}

/** Removes the step or the whole repeat; the last step of a repeat takes its repeat with it. */
export function removeAt(plan: WorkoutPlan, path: StepPath): WorkoutPlan {
  return withNode(plan, path.node, (node) => {
    if (path.step === null || node.type === "step") return [];
    const steps = node.steps.filter((_, position) => position !== path.step);
    return steps.length === 0 ? [] : [{ ...node, steps }];
  });
}

export function duplicateAt(plan: WorkoutPlan, path: StepPath): WorkoutPlan {
  return withNode(plan, path.node, (node) => {
    if (path.step === null || node.type === "step") return [node, node];
    return [{ ...node, steps: node.steps.flatMap((entry, position) => (position === path.step ? [entry, entry] : [entry])) }];
  });
}

/** Moves the step within its repeat, or the top-level node among the nodes. */
export function moveAt(plan: WorkoutPlan, path: StepPath, offset: number): WorkoutPlan {
  if (path.step === null) return { ...plan, nodes: moved(plan.nodes, path.node, offset) };
  const index = path.step;
  return withNode(plan, path.node, (node) => (node.type === "repeat" ? [{ ...node, steps: moved(node.steps, index, offset) }] : [node]));
}

export function canMove(plan: WorkoutPlan, path: StepPath, offset: number): boolean {
  const node = plan.nodes[path.node];
  if (node === undefined) return false;
  const target = (path.step ?? path.node) + offset;
  const length = path.step === null ? plan.nodes.length : node.type === "repeat" ? node.steps.length : 0;
  return target >= 0 && target < length;
}

/** Turns a top-level step into a repeat of it, twice. */
export function repeatStep(plan: WorkoutPlan, index: number): WorkoutPlan {
  return withNode(plan, index, (node) => (node.type === "step" ? [{ type: "repeat", count: 2, steps: [node] }] : [node]));
}

/** Whether the node after the repeat is a step it can take in. */
export function canAbsorbNext(plan: WorkoutPlan, index: number): boolean {
  return plan.nodes[index]?.type === "repeat" && plan.nodes[index + 1]?.type === "step";
}

/** Moves the step following the repeat to the end of its steps. */
export function absorbNext(plan: WorkoutPlan, index: number): WorkoutPlan {
  const repeat = plan.nodes[index];
  const next = plan.nodes[index + 1];
  if (repeat?.type !== "repeat" || next?.type !== "step") return plan;
  return { ...plan, nodes: [...plan.nodes.slice(0, index), { ...repeat, steps: [...repeat.steps, next] }, ...plan.nodes.slice(index + 2)] };
}

/** Replaces the repeat with one round of its steps. */
export function ungroup(plan: WorkoutPlan, index: number): WorkoutPlan {
  return withNode(plan, index, (node) => (node.type === "repeat" ? node.steps : [node]));
}

export function setCount(plan: WorkoutPlan, index: number, count: number): WorkoutPlan {
  return withNode(plan, index, (node) => (node.type === "repeat" ? [{ ...node, count: Math.min(workoutLimits.maxRepeat, Math.max(1, count)) }] : [node]));
}

/** The stepper increment of a time duration: finer on short steps. */
export function timeIncrementMs(ms: number): number {
  if (ms < 60_000) return 5000;
  if (ms < 600_000) return 15_000;
  if (ms < 3_600_000) return 60_000;
  return 300_000;
}

/** The stepper increment of a distance duration: finer on short steps. */
export function distanceIncrementMm(mm: number): number {
  if (mm < 1_000_000) return 50_000;
  if (mm < 5_000_000) return 100_000;
  if (mm < 20_000_000) return 500_000;
  return 1_000_000;
}

/** Keeps a stepped duration on its increment grid, inside the `WKT-002` bounds. */
export function stepDuration(duration: WorkoutDuration, direction: 1 | -1): WorkoutDuration {
  switch (duration.kind) {
    case "time": {
      const increment = timeIncrementMs(direction === 1 ? duration.ms : duration.ms - 1);
      const ms = direction === 1 ? Math.floor(duration.ms / increment) * increment + increment : Math.ceil(duration.ms / increment) * increment - increment;
      return { kind: "time", ms: Math.min(workoutLimits.maxTimeMs, Math.max(workoutLimits.minTimeMs, ms)) };
    }
    case "distance": {
      const increment = distanceIncrementMm(direction === 1 ? duration.mm : duration.mm - 1);
      const mm = direction === 1 ? Math.floor(duration.mm / increment) * increment + increment : Math.ceil(duration.mm / increment) * increment - increment;
      return { kind: "distance", mm: Math.min(workoutLimits.maxDistanceMm, Math.max(workoutLimits.minDistanceMm, mm)) };
    }
    case "open":
      return duration;
    default: {
      const unreachable: never = duration;
      throw new Error(`Unhandled workout duration ${JSON.stringify(unreachable)}`);
    }
  }
}

/** A duration of the chosen kind, worth about the same at `speedMmS` when it is known. */
export function durationOfKind(duration: WorkoutDuration, kind: DurationKind, speedMmS: number | null): WorkoutDuration {
  if (duration.kind === kind) return duration;
  switch (kind) {
    case "time": {
      const ms = duration.kind === "distance" && speedMmS !== null ? (duration.mm / speedMmS) * 1000 : 300_000;
      return { kind: "time", ms: Math.min(workoutLimits.maxTimeMs, Math.max(workoutLimits.minTimeMs, Math.round(ms / 15_000) * 15_000)) };
    }
    case "distance": {
      const mm = duration.kind === "time" && speedMmS !== null ? (duration.ms * speedMmS) / 1000 : 1_000_000;
      return { kind: "distance", mm: Math.min(workoutLimits.maxDistanceMm, Math.max(workoutLimits.minDistanceMm, Math.round(mm / 50_000) * 50_000)) };
    }
    case "open":
      return { kind: "open" };
    default: {
      const unreachable: never = kind;
      throw new Error(`Unhandled duration kind ${JSON.stringify(unreachable)}`);
    }
  }
}

/** A first target of the chosen kind, around `speedMmS` when it is known. */
export function targetOfKind(kind: TargetKind, speedMmS: number | null): WorkoutTarget {
  switch (kind) {
    case "none":
      return { kind: "none" };
    case "pace": {
      const middle = speedMmS === null ? 300 : Math.round(1_000_000 / speedMmS / 5) * 5;
      return { kind: "pace", fastestSecondsPerKm: middle - 5, slowestSecondsPerKm: middle + 5 };
    }
    case "speed": {
      const kmh = speedMmS === null ? 26 : Math.round(speedMmS * 0.0036);
      return { kind: "speed", minMmS: kmhToMmS(kmh - 1), maxMmS: kmhToMmS(kmh + 1) };
    }
    case "heart_rate_zone":
      return { kind: "heart_rate_zone", zone: 2 };
    case "heart_rate":
      return { kind: "heart_rate", minBpm: 140, maxBpm: 150 };
    default: {
      const unreachable: never = kind;
      throw new Error(`Unhandled target kind ${JSON.stringify(unreachable)}`);
    }
  }
}

export function kmhToMmS(kmh: number): number {
  return Math.round(kmh / 0.0036);
}

/** What keeps the plan from being saved or started (`WKT-002`), null when it is valid for the measure. */
export function workoutIssue(plan: WorkoutPlan, measure: Measure): string | null {
  if (plan.nodes.length === 0) return "Ajoute une étape.";
  if (workoutStepCount(plan) > workoutLimits.maxSteps) return `Au plus ${workoutLimits.maxSteps} étapes une fois les répétitions déroulées.`;
  return workoutPlanSchemaFor(measure).safeParse(plan).success ? null : "Une étape a une cible ou une durée hors limites.";
}
