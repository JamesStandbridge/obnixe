import { and, asc, eq, isNull } from "drizzle-orm";
import { gear, session } from "@obnixe/schema";
import type { EpochMs, FieldValues, Gear, Id, SportKey } from "@obnixe/schema";
import type { Environment, ObnixeDatabase } from "../database.ts";
import type { Mutation } from "../writer.ts";

export interface GearUsage {
  readonly gear: Gear;
  readonly meters: number;
}

export interface GearPlan {
  readonly gearId: Id;
  readonly mutation: Mutation;
}

/** `INT-011`: the threshold the user may set, in whole meters. */
export const gearWearBounds = { minMeters: 1000, maxMeters: 100_000_000 } as const;

/** `INT-011`: the saved activity carried its gear past the wear threshold. */
export interface GearWearAlert {
  readonly gear: Gear;
  readonly meters: number;
  readonly wearMeters: number;
}

export class EmptyGearNameError extends Error {
  constructor() {
    super("Gear name is empty");
  }
}

export class InvalidGearWearError extends Error {
  constructor(readonly wearMeters: number) {
    super(`Invalid gear wear threshold ${wearMeters}`);
  }
}

function sessionMeters(values: FieldValues): number {
  return typeof values.distance === "number" ? values.distance : 0;
}

function travelledMeters(db: ObnixeDatabase, gearId: Id): number {
  const sessions = db
    .select({ values: session.values })
    .from(session)
    .where(and(eq(session.gearId, gearId), eq(session.status, "completed"), isNull(session.deletedAt)))
    .all();
  return sessions.reduce((total, row) => total + sessionMeters(row.values), 0);
}

export function gearUsage(db: ObnixeDatabase, sport: SportKey): GearUsage[] {
  const owned = db
    .select()
    .from(gear)
    .where(and(eq(gear.sport, sport), isNull(gear.retiredAt)))
    .orderBy(asc(gear.createdAt))
    .all();
  return owned.map((item) => ({ gear: item, meters: item.initialMeters + travelledMeters(db, item.id) }));
}

/** The gear reached its wear threshold (`INT-011`). */
export function isWorn(usage: GearUsage): boolean {
  return usage.gear.wearMeters !== null && usage.meters >= usage.gear.wearMeters;
}

export function newGear(env: Environment, sport: SportKey, name: string): GearPlan {
  const trimmed = name.trim();
  if (trimmed === "") throw new EmptyGearNameError();
  const gearId = env.newId();
  return { gearId, mutation: { kind: "insert", table: "gear", row: { id: gearId, sport, name: trimmed, initialMeters: 0, wearMeters: null, retiredAt: null } } };
}

/** Sets or clears the wear threshold (`INT-011`); `null` when it does not change. */
export function setGearWear(item: Gear, wearMeters: number | null): Mutation | null {
  if (wearMeters !== null && (!Number.isInteger(wearMeters) || wearMeters < gearWearBounds.minMeters || wearMeters > gearWearBounds.maxMeters)) {
    throw new InvalidGearWearError(wearMeters);
  }
  if (wearMeters === item.wearMeters) return null;
  return { kind: "update", table: "gear", key: item.id, patch: { wearMeters } };
}

/** Retired gear is no longer offered nor counted as worn. */
export function retireGear(gearId: Id, at: EpochMs): Mutation {
  return { kind: "update", table: "gear", key: gearId, patch: { retiredAt: at } };
}

/**
 * `INT-011` after the save of `sessionId`: its gear when this activity carried it to or past its wear threshold, so the
 * signal comes once, with the activity that wore the gear out.
 */
export function gearWearAlert(db: ObnixeDatabase, sessionId: Id): GearWearAlert | null {
  const row = db
    .select({ gear, values: session.values, status: session.status, deletedAt: session.deletedAt })
    .from(session)
    .innerJoin(gear, eq(gear.id, session.gearId))
    .where(eq(session.id, sessionId))
    .get();
  if (row === undefined || row.status !== "completed" || row.deletedAt !== null) return null;
  const { wearMeters, retiredAt } = row.gear;
  if (wearMeters === null || retiredAt !== null) return null;
  const meters = row.gear.initialMeters + travelledMeters(db, row.gear.id);
  const before = meters - sessionMeters(row.values);
  return meters >= wearMeters && before < wearMeters ? { gear: row.gear, meters, wearMeters } : null;
}
