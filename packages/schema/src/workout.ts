import { z } from "zod";
import type { RecordingProfile } from "./catalog/recording.ts";
import { heartRateZoneSchema, secondsPerKmSchema, speedMmSSchema } from "./recording.ts";

export const workoutIntents = ["warmup", "work", "recovery", "rest", "cooldown"] as const;
export type WorkoutIntent = (typeof workoutIntents)[number];

/** `WKT-002` bounds: durations of 5 s to 6 h or 50 m to 100 km, repeats of 1 to 50, at most 200 steps once unfolded. */
export const workoutLimits = {
  minTimeMs: 5000,
  maxTimeMs: 21_600_000,
  minDistanceMm: 50_000,
  maxDistanceMm: 100_000_000,
  maxRepeat: 50,
  maxSteps: 200,
} as const;

export type WorkoutDuration = { readonly kind: "time"; readonly ms: number } | { readonly kind: "distance"; readonly mm: number } | { readonly kind: "open" };

export type HeartRateZoneTarget = 1 | 2 | 3 | 4 | 5;

export type WorkoutTarget =
  | { readonly kind: "none" }
  | { readonly kind: "pace"; readonly fastestSecondsPerKm: number; readonly slowestSecondsPerKm: number }
  | { readonly kind: "speed"; readonly minMmS: number; readonly maxMmS: number }
  | { readonly kind: "heart_rate_zone"; readonly zone: HeartRateZoneTarget }
  | { readonly kind: "heart_rate"; readonly minBpm: number; readonly maxBpm: number };

export type WorkoutStep = {
  readonly type: "step";
  readonly intent: WorkoutIntent;
  readonly duration: WorkoutDuration;
  readonly target: WorkoutTarget;
  readonly label: string | null;
};

export type WorkoutRepeat = {
  readonly type: "repeat";
  readonly count: number;
  readonly steps: readonly WorkoutStep[];
};

export type WorkoutNode = WorkoutStep | WorkoutRepeat;

/** The structured course of a guided workout (`DEC-10`), carried by `program_variant.workout` and frozen in `recording.workout` (`WKT-009`). */
export type WorkoutPlan = {
  readonly version: 1;
  readonly nodes: readonly WorkoutNode[];
};

const bpmSchema = z.int().min(30).max(240);

const workoutDurationSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("time"), ms: z.int().min(workoutLimits.minTimeMs).max(workoutLimits.maxTimeMs) }),
  z.strictObject({ kind: z.literal("distance"), mm: z.int().min(workoutLimits.minDistanceMm).max(workoutLimits.maxDistanceMm) }),
  z.strictObject({ kind: z.literal("open") }),
]);

const workoutTargetSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("none") }),
  z
    .strictObject({ kind: z.literal("pace"), fastestSecondsPerKm: secondsPerKmSchema, slowestSecondsPerKm: secondsPerKmSchema })
    .refine((target) => target.fastestSecondsPerKm < target.slowestSecondsPerKm, { path: ["slowestSecondsPerKm"], message: "The fastest pace must be below the slowest" }),
  z.strictObject({ kind: z.literal("speed"), minMmS: speedMmSSchema, maxMmS: speedMmSSchema }).refine((target) => target.minMmS < target.maxMmS, { path: ["maxMmS"] }),
  z.strictObject({ kind: z.literal("heart_rate_zone"), zone: heartRateZoneSchema }),
  z.strictObject({ kind: z.literal("heart_rate"), minBpm: bpmSchema, maxBpm: bpmSchema }).refine((target) => target.minBpm < target.maxBpm, { path: ["maxBpm"] }),
]);

const workoutStepSchema = z.strictObject({
  type: z.literal("step"),
  intent: z.enum(workoutIntents),
  duration: workoutDurationSchema,
  target: workoutTargetSchema,
  label: z.string().trim().min(1).max(60).nullable(),
});

/** A repeat holds steps only: a repeat inside a repeat is refused by its shape. */
const workoutRepeatSchema = z.strictObject({
  type: z.literal("repeat"),
  count: z.int().min(1).max(workoutLimits.maxRepeat),
  steps: z.array(workoutStepSchema).min(1),
});

/** Steps of the plan once its repeats are unfolded. */
export function workoutStepCount(plan: Pick<WorkoutPlan, "nodes">): number {
  return plan.nodes.reduce((count, node) => count + (node.type === "step" ? 1 : node.count * node.steps.length), 0);
}

/** `WKT-002`, without the sport: the shape, the bounds, a non-empty plan of at most 200 unfolded steps. */
export const workoutPlanSchema = z
  .strictObject({
    version: z.literal(1),
    nodes: z.array(z.discriminatedUnion("type", [workoutStepSchema, workoutRepeatSchema])).min(1),
  })
  .refine((plan) => workoutStepCount(plan) <= workoutLimits.maxSteps, { path: ["nodes"], message: `At most ${workoutLimits.maxSteps} steps once repeats are unfolded` }) satisfies z.ZodType<WorkoutPlan>;

function stepsOf(plan: WorkoutPlan): readonly WorkoutStep[] {
  return plan.nodes.flatMap((node) => (node.type === "step" ? [node] : node.steps));
}

/** A pace target needs a pace sport and a speed target a speed sport (`WKT-002`): no pace for cycling, no speed for running. */
export function workoutFitsMeasure(plan: WorkoutPlan, primary: RecordingProfile["primary"]): boolean {
  return stepsOf(plan).every((step) => (step.target.kind === "pace" ? primary === "pace" : step.target.kind === "speed" ? primary === "speed" : true));
}

/** `WKT-002` for a sport whose profile measures `primary`. */
export function workoutPlanSchemaFor(primary: RecordingProfile["primary"]): z.ZodType<WorkoutPlan> {
  return workoutPlanSchema.refine((plan) => workoutFitsMeasure(plan, primary), {
    path: ["nodes"],
    message: primary === "pace" ? "A speed target needs a speed sport" : "A pace target needs a pace sport",
  });
}
