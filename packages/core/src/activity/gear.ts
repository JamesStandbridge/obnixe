import { and, asc, eq, isNull } from "drizzle-orm";
import { gear, session } from "@obnixe/schema";
import type { Gear, Id, SportKey } from "@obnixe/schema";
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

export class EmptyGearNameError extends Error {
  constructor() {
    super("Gear name is empty");
  }
}

export function gearUsage(db: ObnixeDatabase, sport: SportKey): GearUsage[] {
  const owned = db
    .select()
    .from(gear)
    .where(and(eq(gear.sport, sport), isNull(gear.retiredAt)))
    .orderBy(asc(gear.createdAt))
    .all();
  return owned.map((item) => {
    const sessions = db
      .select({ values: session.values })
      .from(session)
      .where(and(eq(session.gearId, item.id), eq(session.status, "completed"), isNull(session.deletedAt)))
      .all();
    const travelled = sessions.reduce((total, row) => total + (typeof row.values.distance === "number" ? row.values.distance : 0), 0);
    return { gear: item, meters: item.initialMeters + travelled };
  });
}

export function newGear(env: Environment, sport: SportKey, name: string): GearPlan {
  const trimmed = name.trim();
  if (trimmed === "") throw new EmptyGearNameError();
  const gearId = env.newId();
  return { gearId, mutation: { kind: "insert", table: "gear", row: { id: gearId, sport, name: trimmed, initialMeters: 0, retiredAt: null } } };
}
