import type { WorkoutEstimate, WorkoutStepRun } from "@obnixe/core";
import type { PaceRange, WorkoutDuration, WorkoutIntent, WorkoutNode, WorkoutPlan, WorkoutStep, WorkoutTarget } from "@obnixe/schema";
import { formatClock, formatLongClock, formatTargetDuration } from "@/format/durations";
import { formatNumber } from "@/format/numbers";

export type StepTarget = Exclude<WorkoutTarget, { readonly kind: "none" }>;

export const intentLabels: Readonly<Record<WorkoutIntent, string>> = {
  warmup: "Échauffement",
  work: "Travail",
  recovery: "Récupération",
  rest: "Repos",
  cooldown: "Retour au calme",
};

export const intentShortLabels: Readonly<Record<WorkoutIntent, string>> = { warmup: "Échauff.", work: "Travail", recovery: "Récup", rest: "Repos", cooldown: "Calme" };

/** The word a compact step adds after its duration, none for the intents the order already tells. */
const intentWords: Readonly<Record<WorkoutIntent, string | null>> = { warmup: null, work: null, recovery: "récup", rest: "repos", cooldown: null };

export function stepTitle(step: Pick<WorkoutStepRun, "intent" | "label">): string {
  return step.label === null ? intentLabels[step.intent] : `${intentLabels[step.intent]} · ${step.label}`;
}

export function paceRangeText(range: PaceRange): string {
  switch (range.kind) {
    case "pace":
      return `${formatClock(range.fastestSecondsPerKm)} – ${formatClock(range.slowestSecondsPerKm)} /km`;
    case "speed":
      return `${formatNumber(range.minMmS * 0.0036)} – ${formatNumber(range.maxMmS * 0.0036)} km/h`;
    default: {
      const unreachable: never = range;
      throw new Error(`Unhandled pace range ${JSON.stringify(unreachable)}`);
    }
  }
}

export function distanceLabel(mm: number): string {
  return mm < 1_000_000 ? `${formatNumber(mm / 1000, 0)} m` : `${formatNumber(mm / 1_000_000, 2)} km`;
}

/** « 400 m », « 1,5 km », « 1:30 », or the open step's ending. */
export function workoutDurationText(duration: WorkoutDuration): string {
  switch (duration.kind) {
    case "time":
      return formatLongClock(duration.ms / 1000);
    case "distance":
      return distanceLabel(duration.mm);
    case "open":
      return "Jusqu'à l'étape suivante";
    default: {
      const unreachable: never = duration;
      throw new Error(`Unhandled workout duration ${JSON.stringify(unreachable)}`);
    }
  }
}

export function workoutTargetText(target: StepTarget): string {
  switch (target.kind) {
    case "pace":
    case "speed":
      return paceRangeText(target);
    case "heart_rate_zone":
      return `Z${target.zone}`;
    case "heart_rate":
      return `${target.minBpm} – ${target.maxBpm} bpm`;
    default: {
      const unreachable: never = target;
      throw new Error(`Unhandled workout target ${JSON.stringify(unreachable)}`);
    }
  }
}

function compactDuration(duration: WorkoutDuration): string {
  switch (duration.kind) {
    case "time":
      return duration.ms % 60_000 === 0 ? formatTargetDuration(duration.ms / 1000) : formatLongClock(duration.ms / 1000);
    case "distance":
      return distanceLabel(duration.mm);
    case "open":
      return "libre";
    default: {
      const unreachable: never = duration;
      throw new Error(`Unhandled workout duration ${JSON.stringify(unreachable)}`);
    }
  }
}

function compactTarget(target: WorkoutTarget): string | null {
  switch (target.kind) {
    case "none":
      return null;
    case "pace":
      return `${formatClock(target.fastestSecondsPerKm)}–${formatClock(target.slowestSecondsPerKm)}`;
    case "speed":
      return `${formatNumber(target.minMmS * 0.0036)}–${formatNumber(target.maxMmS * 0.0036)} km/h`;
    case "heart_rate_zone":
      return `Z${target.zone}`;
    case "heart_rate":
      return `${target.minBpm}–${target.maxBpm} bpm`;
    default: {
      const unreachable: never = target;
      throw new Error(`Unhandled workout target ${JSON.stringify(unreachable)}`);
    }
  }
}

/** « 400 m Z4 », « 1:30 récup ». */
export function compactStep(step: Pick<WorkoutStep, "intent" | "duration" | "target">): string {
  return [compactDuration(step.duration), compactTarget(step.target), intentWords[step.intent]].filter((part): part is string => part !== null).join(" ");
}

function compactNode(node: WorkoutNode): string {
  switch (node.type) {
    case "step":
      return compactStep(node);
    case "repeat": {
      const steps = node.steps.map(compactStep);
      return steps.length === 1 ? `${node.count} × ${steps[0]}` : `${node.count} × (${steps.join(" · ")})`;
    }
    default: {
      const unreachable: never = node;
      throw new Error(`Unhandled workout node ${JSON.stringify(unreachable)}`);
    }
  }
}

/** `WKT-001`: « 15 min · 8 × (400 m Z4 · 1:30 récup) · 10 min ». */
export function workoutText(plan: Pick<WorkoutPlan, "nodes">): string {
  return plan.nodes.map(compactNode).join(" · ");
}

/** `WKT-001`: « ≈ 10 km · 50 min », null for an empty plan. */
export function estimateText(estimate: WorkoutEstimate): string | null {
  const parts: string[] = [];
  if (estimate.distanceMm > 0) parts.push(`${formatNumber(estimate.distanceMm / 1_000_000, estimate.distanceMm >= 10_000_000 ? 0 : 1)} km`);
  if (estimate.durationMs > 0) parts.push(formatTargetDuration(estimate.durationMs / 1000));
  return parts.length === 0 ? null : `≈ ${parts.join(" · ")}`;
}
