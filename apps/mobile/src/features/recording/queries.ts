import { and, desc, eq, isNull } from "drizzle-orm";
import { enabledSports, resolveProfile } from "@obnixe/core";
import { gear, programSlot, programVariant, recording, session, sports } from "@obnixe/schema";
import type { FieldValues, Id, ProgramSlot, SportKey, SportPreference } from "@obnixe/schema";
import { db } from "@/data/database";
import { slotTarget } from "@/features/recording/target";
import type { SlotTarget } from "@/features/recording/target";
import { sessionTitle } from "@/format/labels";

const gearLookback = 50;

export function isRecordable(sport: SportKey): boolean {
  return sports[sport].recording !== null;
}

export function recordableSports(preferences: readonly SportPreference[]): readonly SportKey[] {
  return enabledSports(preferences).filter(isRecordable);
}

/** `REC-001`: the sport of the latest live recording among `among`, else the first of them. */
export function lastRecordedSport(among: readonly SportKey[]): SportKey | null {
  const rows = db()
    .select({ sport: session.sport })
    .from(recording)
    .innerJoin(session, eq(recording.sessionId, session.id))
    .where(and(eq(recording.source, "live"), isNull(session.deletedAt)))
    .orderBy(desc(session.startedAt))
    .limit(gearLookback)
    .all();
  return rows.find((row) => among.includes(row.sport))?.sport ?? among[0] ?? null;
}

/** `INT-010`: the gear of the latest activity of this sport and option, unless it was retired since. */
export function defaultGear(sport: SportKey, kind: string | null): Id | null {
  if (!sports[sport].usesGear) return null;
  const rows = db()
    .select({ gearId: session.gearId, values: session.values })
    .from(session)
    .where(and(eq(session.sport, sport), isNull(session.deletedAt)))
    .orderBy(desc(session.startedAt))
    .limit(gearLookback)
    .all();
  const latest = rows.find((row) => (typeof row.values.kind === "string" ? row.values.kind : null) === kind) ?? rows[0];
  if (latest?.gearId == null) return null;
  const owned = db().select({ retiredAt: gear.retiredAt }).from(gear).where(eq(gear.id, latest.gearId)).get();
  return owned === undefined || owned.retiredAt !== null ? null : latest.gearId;
}

function slotValues(slot: Pick<ProgramSlot, "targetValues">): FieldValues {
  const kind = slot.targetValues.kind;
  return typeof kind === "string" ? { kind } : {};
}

/** `INT-002`: a slot of a sport, and option, that records a track starts a live recording. */
export function slotRecordable(slot: Pick<ProgramSlot, "sport" | "targetValues">): boolean {
  return resolveProfile(slot.sport, slotValues(slot)) !== null;
}

export interface SlotStart {
  readonly slot: ProgramSlot;
  readonly variantId: Id | null;
  readonly variantName: string | null;
  /** The slot's option, such as `kind = 'long'`, for the session values. */
  readonly values: FieldValues;
  readonly target: SlotTarget | null;
}

export function slotStartOf(slotId: Id, variantId: Id | null): SlotStart | null {
  const slot = db().select().from(programSlot).where(eq(programSlot.id, slotId)).get();
  if (slot === undefined) return null;
  const variant = variantId === null ? undefined : db().select({ name: programVariant.name }).from(programVariant).where(eq(programVariant.id, variantId)).get();
  return { slot, variantId: variant === undefined ? null : variantId, variantName: variant?.name ?? null, values: slotValues(slot), target: slotTarget(slot) };
}

export function recordingTitle(sessionId: Id): string | null {
  const row = db()
    .select({ sport: session.sport, title: session.title, values: session.values, startedAt: session.startedAt, timeZone: session.timeZone, slotName: programSlot.name, variantName: programVariant.name })
    .from(session)
    .leftJoin(programSlot, eq(session.slotId, programSlot.id))
    .leftJoin(programVariant, eq(session.variantId, programVariant.id))
    .where(eq(session.id, sessionId))
    .get();
  return row === undefined ? null : sessionTitle({ ...row, recorded: true });
}

/** Where a recording link leads once the recording is over: its session, unless it was deleted. */
export function sessionExists(sessionId: Id): boolean {
  return db().select({ id: session.id }).from(session).where(and(eq(session.id, sessionId), isNull(session.deletedAt))).get() !== undefined;
}

/** The slot target of an open recording, for its live screen (`UX-005`). */
export function sessionTargetOf(sessionId: Id): SlotTarget | null {
  const row = db().select({ slot: programSlot }).from(session).innerJoin(programSlot, eq(session.slotId, programSlot.id)).where(eq(session.id, sessionId)).get();
  return row === undefined ? null : slotTarget(row.slot);
}
