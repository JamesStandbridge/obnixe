import { and, asc, desc, eq, isNull, or, sql } from "drizzle-orm";
import { program, programSlot, programVariant, programVersion, rotationSkip, session } from "@obnixe/schema";
import type { EpochMs, Id, LocalDate, Program, ProgramSlot, ProgramVariant, ProgramVersion, Session, SportKey } from "@obnixe/schema";
import type { ObnixeDatabase } from "./database.ts";
import { localDateOf } from "./dates.ts";
import type { Mutation } from "./writer.ts";

export interface CurrentProgram {
  readonly program: Program;
  readonly version: ProgramVersion;
  readonly slots: readonly ProgramSlot[];
}

export type CycleCheck =
  | { readonly kind: "done"; readonly sessionId: Id; readonly at: EpochMs; readonly localDate: LocalDate }
  | { readonly kind: "skipped"; readonly at: EpochMs; readonly localDate: LocalDate };

export type CycleSlotState = CycleCheck | { readonly kind: "next" } | { readonly kind: "pending" };

export interface CycleSlot {
  readonly slot: ProgramSlot;
  readonly state: CycleSlotState;
}

export interface NextSlot {
  readonly current: CurrentProgram;
  readonly slot: ProgramSlot;
  readonly variants: readonly ProgramVariant[];
  readonly after: ProgramSlot | null;
  readonly cycle: readonly CycleSlot[];
}

export interface RotationOptions {
  readonly countingSessionId: Id | null;
}

interface RotationEvent {
  readonly slotLineageId: Id;
  readonly at: EpochMs;
  readonly startedAt: EpochMs;
  readonly id: Id;
  readonly check: CycleCheck;
}

export function currentProgram(db: ObnixeDatabase): CurrentProgram | null {
  const active = db.select().from(program).where(eq(program.status, "active")).get();
  if (active === undefined) return null;
  const version = db.select().from(programVersion).where(eq(programVersion.programId, active.id)).orderBy(desc(programVersion.number)).get();
  if (version === undefined) return null;
  const slots = db.select().from(programSlot).where(eq(programSlot.versionId, version.id)).orderBy(asc(programSlot.position)).all();
  return { program: active, version, slots };
}

/** Sessions enter the rotation when they end, so a session logged afterwards with a past start is replayed at that past time. */
function rotationEvents(db: ObnixeDatabase, programId: Id, options: RotationOptions): RotationEvent[] {
  const at = sql<EpochMs>`coalesce(${session.endedAt}, ${session.startedAt})`;
  const counts = options.countingSessionId === null ? eq(session.countsInRotation, true) : or(eq(session.countsInRotation, true), eq(session.id, options.countingSessionId));
  const done = db
    .select({ id: session.id, slotLineageId: programSlot.lineageId, at, startedAt: session.startedAt, localDate: session.localDate })
    .from(session)
    .innerJoin(programSlot, eq(session.slotId, programSlot.id))
    .innerJoin(programVersion, eq(programSlot.versionId, programVersion.id))
    .where(and(eq(programVersion.programId, programId), counts, eq(session.status, "completed"), isNull(session.deletedAt)))
    .all();
  const skipped = db.select().from(rotationSkip).where(eq(rotationSkip.programId, programId)).all();
  const events: RotationEvent[] = [
    ...done.map((row) => ({ slotLineageId: row.slotLineageId, at: row.at, startedAt: row.startedAt, id: row.id, check: { kind: "done", sessionId: row.id, at: row.at, localDate: row.localDate } as const })),
    ...skipped.map((row) => ({ slotLineageId: row.slotLineageId, at: row.skippedAt, startedAt: row.skippedAt, id: row.id, check: { kind: "skipped", at: row.skippedAt, localDate: row.localDate } as const })),
  ];
  return events.sort((left, right) => left.at - right.at || left.startedAt - right.startedAt || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
}

/**
 * Replays the history against the current slots: an event checks its lineage in the running cycle, a lineage checked twice opens a new cycle
 * holding only that event, and the cycle closes as soon as every current lineage is checked. Lineages absent from the current version are ignored.
 */
function openCycle(slots: readonly ProgramSlot[], events: readonly RotationEvent[]): ReadonlyMap<Id, CycleCheck> {
  const lineages = new Set(slots.map((slot) => slot.lineageId));
  let checked = new Map<Id, CycleCheck>();
  for (const event of events) {
    if (!lineages.has(event.slotLineageId)) continue;
    if (checked.has(event.slotLineageId)) checked = new Map();
    checked.set(event.slotLineageId, event.check);
    if (checked.size === lineages.size) checked = new Map();
  }
  return checked;
}

export function nextSlot(db: ObnixeDatabase, options: RotationOptions = { countingSessionId: null }): NextSlot | null {
  const current = currentProgram(db);
  if (current === null || current.slots.length === 0) return null;
  const checked = openCycle(current.slots, rotationEvents(db, current.program.id, options));
  const index = current.slots.findIndex((slot) => !checked.has(slot.lineageId));
  const slot = current.slots[index];
  if (slot === undefined) return null;
  const variants = db.select().from(programVariant).where(eq(programVariant.slotId, slot.id)).orderBy(asc(programVariant.position)).all();
  const following = current.slots.find((candidate, position) => position > index && !checked.has(candidate.lineageId));
  const after = current.slots.length > 1 ? (following ?? current.slots[0] ?? null) : null;
  const cycle = current.slots.map((candidate, position): CycleSlot => ({ slot: candidate, state: checked.get(candidate.lineageId) ?? (position === index ? { kind: "next" } : { kind: "pending" }) }));
  return { current, slot, variants, after, cycle };
}

export function isOpenInCycle(state: CycleSlotState): boolean {
  switch (state.kind) {
    case "next":
    case "pending":
      return true;
    case "done":
    case "skipped":
      return false;
    default: {
      const unreachable: never = state;
      throw new Error(`Unhandled cycle state ${String(unreachable)}`);
    }
  }
}

/** Slots of a sport still to do in the current cycle, in rotation order. */
export function openSlotsOfSport(next: NextSlot, sport: SportKey): readonly CycleSlot[] {
  return next.cycle.filter((entry) => entry.slot.sport === sport && isOpenInCycle(entry.state));
}

/** Slots of a sport a session can be attached to: those still to do in the cycle first, then the checked ones, each group in rotation order. */
export function attachableSlots(next: NextSlot, sport: SportKey): readonly CycleSlot[] {
  const own = next.cycle.filter((entry) => entry.slot.sport === sport);
  return [...own.filter((entry) => isOpenInCycle(entry.state)), ...own.filter((entry) => !isOpenInCycle(entry.state))];
}

/** Attaching keeps the variant only when the slot stays the same, since a variant belongs to its slot. */
export function attachSessionMutation(target: Pick<Session, "id" | "slotId" | "variantId">, slotId: Id | null): Mutation {
  return {
    kind: "update",
    table: "session",
    key: target.id,
    patch: slotId === null ? { slotId: null, variantId: null, countsInRotation: false } : { slotId, variantId: slotId === target.slotId ? target.variantId : null, countsInRotation: true },
  };
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
