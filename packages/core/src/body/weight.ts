import { and, eq, isNull } from "drizzle-orm";
import { weighIn } from "@obnixe/schema";
import type { EpochMs, Id, LocalDate, MassUnit, WeighIn } from "@obnixe/schema";
import type { Environment, ObnixeDatabase } from "../database.ts";
import type { Mutation } from "../writer.ts";
import { fromStored, massUnitOf, toStored } from "../activity/catalog.ts";
import { addDays, daysBetween, localDateOf } from "../dates.ts";

export const weighInBounds = { minGrams: 20_000, maxGrams: 400_000 } as const;

export interface WeighInDraft {
  readonly grams: number;
  readonly occurredAt: EpochMs;
  readonly timeZone: string;
}

export interface WeighInPlan {
  readonly weighInId: Id;
  readonly replaced: WeighIn | null;
  readonly mutation: Mutation;
}

export interface WeightPoint {
  readonly localDate: LocalDate;
  readonly grams: number;
}

export interface DayWeight {
  readonly localDate: LocalDate;
  readonly grams: number | null;
}

export interface WeightTrend {
  readonly latest: WeightPoint | null;
  readonly today: WeightPoint | null;
  readonly average7: number | null;
  readonly delta7: number | null;
  readonly delta30: number | null;
  readonly days: readonly DayWeight[];
}

export class WeightOutOfRangeError extends Error {
  constructor(readonly grams: number) {
    super(`Weight ${grams} g is outside ${weighInBounds.minGrams}-${weighInBounds.maxGrams} g`);
  }
}

export function gramsToMass(grams: number, unit: MassUnit): number {
  return fromStored(grams, massUnitOf(unit));
}

export function massToGrams(value: number, unit: MassUnit): number {
  return toStored(value, massUnitOf(unit));
}

export function weighInOn(db: ObnixeDatabase, localDate: LocalDate): WeighIn | null {
  return db.select().from(weighIn).where(and(eq(weighIn.localDate, localDate), isNull(weighIn.deletedAt))).get() ?? null;
}

export function planWeighIn(db: ObnixeDatabase, env: Environment, draft: WeighInDraft): WeighInPlan {
  const grams = Math.round(draft.grams);
  if (grams < weighInBounds.minGrams || grams > weighInBounds.maxGrams) throw new WeightOutOfRangeError(grams);
  const localDate = localDateOf(draft.occurredAt, draft.timeZone);
  const existing = weighInOn(db, localDate);
  if (existing !== null) {
    return { weighInId: existing.id, replaced: existing, mutation: { kind: "update", table: "weigh_in", key: existing.id, patch: { grams, occurredAt: draft.occurredAt, timeZone: draft.timeZone } } };
  }
  const weighInId = env.newId();
  return {
    weighInId,
    replaced: null,
    mutation: { kind: "insert", table: "weigh_in", row: { id: weighInId, occurredAt: draft.occurredAt, localDate, timeZone: draft.timeZone, grams, deletedAt: null } },
  };
}

export function planTrash(env: Environment, table: "weigh_in" | "measurement" | "photo", id: Id): Mutation {
  return { kind: "update", table, key: id, patch: { deletedAt: env.now() } };
}

function mean(values: readonly number[]): number | null {
  return values.length === 0 ? null : values.reduce((total, value) => total + value, 0) / values.length;
}

function windowMean(points: readonly WeightPoint[], end: LocalDate, days: number): number | null {
  return mean(points.filter((point) => daysBetween(point.localDate, end) >= 0 && daysBetween(point.localDate, end) < days).map((point) => point.grams));
}

export function weightTrend(points: readonly WeightPoint[], today: LocalDate): WeightTrend {
  const sorted = [...points].sort((left, right) => left.localDate.localeCompare(right.localDate));
  const byDay = new Map(sorted.map((point) => [point.localDate, point.grams]));
  const average7 = windowMean(sorted, today, 7);
  const previousWeek = windowMean(sorted, addDays(today, -7), 7);
  const earlier = windowMean(sorted, addDays(today, -30), 7);
  return {
    latest: sorted.at(-1) ?? null,
    today: byDay.has(today) ? { localDate: today, grams: byDay.get(today) ?? 0 } : null,
    average7,
    delta7: average7 === null || previousWeek === null ? null : average7 - previousWeek,
    delta30: average7 === null || earlier === null ? null : average7 - earlier,
    days: Array.from({ length: 7 }, (_, index) => {
      const localDate = addDays(today, index - 6);
      return { localDate, grams: byDay.get(localDate) ?? null };
    }),
  };
}
