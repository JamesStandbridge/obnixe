import { and, asc, desc, eq, isNull } from "drizzle-orm";
import { program, programSlot, programVariant, programVersion, rotationSkip, session } from "@obnixe/schema";
import type { EpochMs, Id, Program, ProgramSlot, ProgramVariant, ProgramVersion } from "@obnixe/schema";
import type { ObnixeDatabase } from "./database.ts";

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

export function lastRotationEvent(db: ObnixeDatabase, programId: Id): RotationEvent | null {
  const done = db
    .select({ slotLineageId: programSlot.lineageId, at: session.startedAt })
    .from(session)
    .innerJoin(programSlot, eq(session.slotId, programSlot.id))
    .innerJoin(programVersion, eq(programSlot.versionId, programVersion.id))
    .where(and(eq(programVersion.programId, programId), eq(session.countsInRotation, true), eq(session.status, "completed"), isNull(session.deletedAt)))
    .orderBy(desc(session.startedAt))
    .get();
  const skipped = db
    .select({ slotLineageId: rotationSkip.slotLineageId, at: rotationSkip.skippedAt })
    .from(rotationSkip)
    .where(eq(rotationSkip.programId, programId))
    .orderBy(desc(rotationSkip.skippedAt))
    .get();
  if (done === undefined) return skipped ?? null;
  if (skipped === undefined) return done;
  return skipped.at > done.at ? skipped : done;
}

export function nextSlot(db: ObnixeDatabase): NextSlot | null {
  const current = currentProgram(db);
  if (current === null || current.slots.length === 0) return null;
  const event = lastRotationEvent(db, current.program.id);
  const lastIndex = event === null ? -1 : current.slots.findIndex((slot) => slot.lineageId === event.slotLineageId);
  const index = (lastIndex + 1) % current.slots.length;
  const slot = current.slots[index];
  if (slot === undefined) return null;
  const variants = db.select().from(programVariant).where(eq(programVariant.slotId, slot.id)).orderBy(asc(programVariant.position)).all();
  const after = current.slots.length > 1 ? (current.slots[(index + 1) % current.slots.length] ?? null) : null;
  return { current, slot, variants, after };
}
