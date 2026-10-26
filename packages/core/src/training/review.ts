import { eq } from "drizzle-orm";
import { programSlot } from "@obnixe/schema";
import type { Effort, EpochMs, Id, PainLevel, PainReport, ProgramSlot, Sensation, Session, ZoneKey } from "@obnixe/schema";
import type { ObnixeDatabase } from "../database.ts";
import { currentProgram, nextSlot } from "../rotation.ts";
import type { Mutation } from "../writer.ts";
import { sessionPainMutations } from "./pain.ts";
import { localDateOf } from "./time.ts";

export interface RotationChoice {
  readonly slot: ProgramSlot;
  readonly next: ProgramSlot | null;
  readonly assigned: boolean;
}

export function rotationChoice(db: ObnixeDatabase, current: Session): RotationChoice | null {
  const program = currentProgram(db);
  if (current.slotId !== null) {
    const own = db.select().from(programSlot).where(eq(programSlot.id, current.slotId)).get();
    if (own === undefined) return null;
    const slots = program?.slots ?? [];
    const index = slots.findIndex((slot) => slot.lineageId === own.lineageId);
    const next = index === -1 || slots.length < 2 ? null : (slots[(index + 1) % slots.length] ?? null);
    return { slot: own, next, assigned: true };
  }
  const upcoming = nextSlot(db);
  if (upcoming === null || upcoming.slot.sport !== current.sport) return null;
  return { slot: upcoming.slot, next: upcoming.after, assigned: false };
}

export interface ReviewPain {
  readonly zone: ZoneKey;
  readonly level: PainLevel | null;
}

export interface ReviewRequest {
  readonly session: Session;
  readonly effort: Effort | null;
  readonly sensation: Sensation | null;
  readonly enjoyment: number | null;
  readonly note: string | null;
  readonly rotation: { readonly slotId: Id | null; readonly countsInRotation: boolean };
  readonly pains: readonly ReviewPain[];
  readonly existingEndPains: readonly PainReport[];
  readonly tracked: readonly ZoneKey[];
  readonly now: EpochMs;
  readonly newId: () => Id;
}

export function reviewMutations(request: ReviewRequest): Mutation[] {
  const { session: current } = request;
  const note = request.note === null || request.note.trim() === "" ? null : request.note.trim();
  const reported = request.pains.filter((pain) => pain.level !== null);
  const answered = request.effort !== null || request.sensation !== null || request.enjoyment !== null || note !== null || reported.length > 0;
  const mutations: Mutation[] = [
    {
      kind: "update",
      table: "session",
      key: current.id,
      patch: {
        effort: request.effort,
        sensation: request.sensation,
        enjoyment: request.enjoyment,
        note,
        slotId: request.rotation.slotId,
        countsInRotation: request.rotation.slotId !== null && request.rotation.countsInRotation,
        review: answered ? "done" : "skipped",
      },
    },
  ];
  const fresh = new Map<ZoneKey, PainLevel>();
  for (const pain of request.pains) {
    const existing = request.existingEndPains.find((report) => report.zone === pain.zone && report.deletedAt === null);
    if (existing === undefined) {
      if (pain.level !== null) fresh.set(pain.zone, pain.level);
      continue;
    }
    if (pain.level === null) mutations.push({ kind: "update", table: "pain_report", key: existing.id, patch: { deletedAt: request.now } });
    else if (pain.level !== existing.level) mutations.push({ kind: "update", table: "pain_report", key: existing.id, patch: { level: pain.level } });
  }
  mutations.push(
    ...sessionPainMutations({
      newId: request.newId,
      sessionId: current.id,
      phase: "end",
      strengthSetId: null,
      occurredAt: request.now,
      localDate: localDateOf(request.now, current.timeZone),
      timeZone: current.timeZone,
      levels: fresh,
      tracked: request.tracked,
    }),
  );
  return mutations;
}
