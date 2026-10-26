import { and, eq, isNull, max, sql } from "drizzle-orm";
import { measurement, measurementKind } from "@obnixe/schema";
import type { EpochMs, Id, LocalDate, Measurement, MeasurementKind } from "@obnixe/schema";
import type { Environment, ObnixeDatabase } from "../database.ts";
import type { Mutation } from "../writer.ts";
import { localDateOf } from "../activity/dates.ts";

export interface MeasurementDraft {
  readonly kindId: Id;
  readonly millimeters: number;
  readonly occurredAt: EpochMs;
  readonly timeZone: string;
}

export interface MeasurementPlan {
  readonly measurementId: Id;
  readonly mutation: Mutation;
}

export interface KindPlan {
  readonly kindId: Id;
  readonly mutation: Mutation;
}

export interface MeasurementPoint {
  readonly kindId: Id;
  readonly localDate: LocalDate;
  readonly millimeters: number;
}

export interface KindSummary {
  readonly kind: MeasurementKind;
  readonly latest: MeasurementPoint | null;
  readonly delta: number | null;
}

export interface MeasurementsOverview {
  readonly latestDate: LocalDate | null;
  readonly kinds: readonly KindSummary[];
}

export class DuplicateKindError extends Error {
  constructor(readonly label: string) {
    super(`Measurement kind "${label}" already exists`);
  }
}

export class EmptyKindLabelError extends Error {
  constructor() {
    super("Measurement kind label is empty");
  }
}

export class InvalidMeasurementError extends Error {
  constructor(readonly millimeters: number) {
    super(`Measurement ${millimeters} mm must be a positive integer`);
  }
}

export function planMeasurementKind(db: ObnixeDatabase, env: Environment, label: string): KindPlan {
  const trimmed = label.trim().replace(/\s+/g, " ");
  if (trimmed === "") throw new EmptyKindLabelError();
  const existing = db
    .select()
    .from(measurementKind)
    .where(sql`lower(${measurementKind.label}) = lower(${trimmed})`)
    .get();
  if (existing !== undefined) {
    if (existing.archivedAt === null) throw new DuplicateKindError(trimmed);
    return { kindId: existing.id, mutation: { kind: "update", table: "measurement_kind", key: existing.id, patch: { archivedAt: null } } };
  }
  const last = db.select({ position: max(measurementKind.position) }).from(measurementKind).get();
  const kindId = env.newId();
  return { kindId, mutation: { kind: "insert", table: "measurement_kind", row: { id: kindId, label: trimmed, zone: null, position: (last?.position ?? -1) + 1, archivedAt: null } } };
}

export function planKindArchive(env: Environment, kindId: Id): Mutation {
  return { kind: "update", table: "measurement_kind", key: kindId, patch: { archivedAt: env.now() } };
}

export function planMeasurement(db: ObnixeDatabase, env: Environment, draft: MeasurementDraft): MeasurementPlan {
  const millimeters = Math.round(draft.millimeters);
  if (!Number.isFinite(millimeters) || millimeters <= 0) throw new InvalidMeasurementError(draft.millimeters);
  const localDate = localDateOf(draft.occurredAt, draft.timeZone);
  const existing = db
    .select()
    .from(measurement)
    .where(and(eq(measurement.kindId, draft.kindId), eq(measurement.localDate, localDate), isNull(measurement.deletedAt)))
    .get();
  if (existing !== undefined) {
    return { measurementId: existing.id, mutation: { kind: "update", table: "measurement", key: existing.id, patch: { millimeters, occurredAt: draft.occurredAt, timeZone: draft.timeZone } } };
  }
  const measurementId = env.newId();
  return {
    measurementId,
    mutation: { kind: "insert", table: "measurement", row: { id: measurementId, kindId: draft.kindId, occurredAt: draft.occurredAt, localDate, timeZone: draft.timeZone, millimeters, deletedAt: null } },
  };
}

export function measurementsOverview(kinds: readonly MeasurementKind[], measurements: readonly Pick<Measurement, "kindId" | "localDate" | "millimeters" | "deletedAt">[]): MeasurementsOverview {
  const live = measurements.filter((row) => row.deletedAt === null).sort((left, right) => right.localDate.localeCompare(left.localDate));
  const active = kinds.filter((kind) => kind.archivedAt === null).sort((left, right) => left.position - right.position);
  const summaries = active.map((kind): KindSummary => {
    const history = live.filter((row) => row.kindId === kind.id);
    const latest = history[0];
    const previous = history[1];
    return {
      kind,
      latest: latest === undefined ? null : { kindId: kind.id, localDate: latest.localDate, millimeters: latest.millimeters },
      delta: latest === undefined || previous === undefined ? null : latest.millimeters - previous.millimeters,
    };
  });
  const dates = summaries.map((summary) => summary.latest?.localDate).filter((date): date is LocalDate => date !== undefined);
  return { latestDate: dates.sort().at(-1) ?? null, kinds: summaries };
}
