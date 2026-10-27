import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import { program, programSlot, programVariant, programVersion, rotationSkip, session } from "@obnixe/schema";
import type { EpochMs, Id, Program, ProgramSlot, ProgramVariant, ProgramVersion } from "@obnixe/schema";
import type { ObnixeDatabase } from "./database.ts";
import { localDateOf } from "./dates.ts";
import type { Mutation } from "./writer.ts";

export interface CurrentProgram {
  readonly program: Program;
  readonly version: ProgramVersion;
  readonly slots: readonly ProgramSlot[];
}

export interface NextSlot {
  readonly current: CurrentProgram;
  readonly slot: ProgramSlot;
  readonly variants: readonly ProgramVariant[];
  readonly after: ProgramSlot | null;
}

interface RotationEvent {
  readonly slotLineageId: Id;
  readonly versionId: Id | null;
  readonly at: EpochMs;
}

export function currentProgram(db: ObnixeDatabase): CurrentProgram | null {
  const active = db.select().from(program).where(eq(program.status, "active")).get();
  if (active === undefined) return null;
  const version = db.select().from(programVersion).where(eq(programVersion.programId, active.id)).orderBy(desc(programVersion.number)).get();
  if (version === undefined) return null;
  const slots = db.select().from(programSlot).where(eq(programSlot.versionId, version.id)).orderBy(asc(programSlot.position)).all();
  return { program: active, version, slots };
}

/** Sessions enter the rotation when they end, so a session logged afterwards with a past start still follows an earlier skip. */
export function lastRotationEvent(db: ObnixeDatabase, programId: Id): RotationEvent | null {
  const done = db
    .select({ slotLineageId: programSlot.lineageId, versionId: programSlot.versionId, at: sql<EpochMs>`coalesce(${session.endedAt}, ${session.startedAt})` })
    .from(session)
    .innerJoin(programSlot, eq(session.slotId, programSlot.id))
    .innerJoin(programVersion, eq(programSlot.versionId, programVersion.id))
    .where(and(eq(programVersion.programId, programId), eq(session.countsInRotation, true), eq(session.status, "completed"), isNull(session.deletedAt)))
    .orderBy(desc(sql`coalesce(${session.endedAt}, ${session.startedAt})`), desc(session.startedAt))
    .get();
  const skipped = db
    .select({ slotLineageId: rotationSkip.slotLineageId, at: rotationSkip.skippedAt })
    .from(rotationSkip)
    .where(eq(rotationSkip.programId, programId))
    .orderBy(desc(rotationSkip.skippedAt))
    .get();
  if (skipped !== undefined && (done === undefined || skipped.at > done.at)) return { ...skipped, versionId: lineageVersion(db, programId, skipped.slotLineageId) };
  return done ?? null;
}

function lineageVersion(db: ObnixeDatabase, programId: Id, lineageId: Id): Id | null {
  const slot = db
    .select({ versionId: programSlot.versionId })
    .from(programSlot)
    .innerJoin(programVersion, eq(programSlot.versionId, programVersion.id))
    .where(and(eq(programVersion.programId, programId), eq(programSlot.lineageId, lineageId)))
    .orderBy(desc(programVersion.number))
    .get();
  return slot?.versionId ?? null;
}

/** Index of the slot following the last rotation event. When its lineage left the program, the old version's order is walked forward to the first lineage still present. */
function nextIndexOf(db: ObnixeDatabase, slots: readonly ProgramSlot[], event: RotationEvent | null): number {
  if (event === null) return 0;
  const same = slots.findIndex((slot) => slot.lineageId === event.slotLineageId);
  if (same !== -1) return (same + 1) % slots.length;
  if (event.versionId === null) return 0;
  const previous = db.select({ lineageId: programSlot.lineageId }).from(programSlot).where(eq(programSlot.versionId, event.versionId)).orderBy(asc(programSlot.position)).all();
  const start = previous.findIndex((slot) => slot.lineageId === event.slotLineageId);
  for (let step = 1; step < previous.length; step += 1) {
    const lineageId = previous[(start + step) % previous.length]?.lineageId;
    const found = slots.findIndex((slot) => slot.lineageId === lineageId);
    if (found !== -1) return found;
  }
  return 0;
}

export function nextSlot(db: ObnixeDatabase): NextSlot | null {
  const current = currentProgram(db);
  if (current === null || current.slots.length === 0) return null;
  const index = nextIndexOf(db, current.slots, lastRotationEvent(db, current.program.id));
  const slot = current.slots[index];
  if (slot === undefined) return null;
  const variants = db.select().from(programVariant).where(eq(programVariant.slotId, slot.id)).orderBy(asc(programVariant.position)).all();
  const after = current.slots.length > 1 ? (current.slots[(index + 1) % current.slots.length] ?? null) : null;
  return { current, slot, variants, after };
}

export interface SkipRequest {
  readonly now: EpochMs;
  readonly timeZone: string;
  readonly newId: () => Id;
}

export interface SkipPlan {
  readonly skipped: ProgramSlot;
  readonly next: ProgramSlot;
  readonly mutation: Mutation;
}

/** A rotation with a single slot has nothing to skip to, so it yields no plan. */
export function planSkipNextSlot(db: ObnixeDatabase, request: SkipRequest): SkipPlan | null {
  const next = nextSlot(db);
  if (next === null || next.after === null) return null;
  return {
    skipped: next.slot,
    next: next.after,
    mutation: {
      kind: "insert",
      table: "rotation_skip",
      row: { id: request.newId(), programId: next.current.program.id, slotLineageId: next.slot.lineageId, skippedAt: request.now, localDate: localDateOf(request.now, request.timeZone) },
    },
  };
}
