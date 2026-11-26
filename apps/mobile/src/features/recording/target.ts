import type { AlertGoal } from "@obnixe/core";
import type { FieldValues } from "@obnixe/schema";
import { formatLongClock } from "@/format/durations";
import { formatNumber } from "@/format/numbers";

export type SlotTarget = AlertGoal;

export interface TargetProgress {
  /** From 0 to 1. */
  readonly fraction: number;
  readonly reached: boolean;
  readonly done: string;
  readonly goal: string;
}

/** `INT-003`: the distance target of the slot first, else its duration. */
export function slotTarget(slot: { readonly targetValues: FieldValues; readonly targetDurationSeconds: number | null }): SlotTarget | null {
  const distance = slot.targetValues.distance;
  if (typeof distance === "number" && distance > 0) return { kind: "distance", meters: distance };
  if (slot.targetDurationSeconds !== null && slot.targetDurationSeconds > 0) return { kind: "duration", seconds: slot.targetDurationSeconds };
  return null;
}

export function targetLabel(target: SlotTarget): string {
  switch (target.kind) {
    case "distance":
      return `${formatNumber(target.meters / 1000, 1)} km`;
    case "duration":
      return formatLongClock(target.seconds);
    default: {
      const unreachable: never = target;
      return unreachable;
    }
  }
}

/** `UX-005`: progress toward the slot target, the duration counting the moving time. */
export function targetProgress(target: SlotTarget, live: { readonly distanceMm: number; readonly movingMs: number }): TargetProgress {
  switch (target.kind) {
    case "distance": {
      const meters = live.distanceMm / 1000;
      return { fraction: Math.min(1, meters / target.meters), reached: meters >= target.meters, done: formatNumber(Math.floor(meters / 100) / 10, 1, 1), goal: targetLabel(target) };
    }
    case "duration": {
      const seconds = live.movingMs / 1000;
      return { fraction: Math.min(1, seconds / target.seconds), reached: seconds >= target.seconds, done: formatLongClock(Math.floor(seconds)), goal: targetLabel(target) };
    }
    default: {
      const unreachable: never = target;
      return unreachable;
    }
  }
}
