import { exerciseNameKey, settings } from "@obnixe/schema";
import type { EpochMs, Id, LocalDate } from "@obnixe/schema";
import type { TestContext } from "../testing.ts";
import { commit } from "../writer.ts";
import type { Mutation, NewRow } from "../writer.ts";

export interface Fixtures {
  readonly write: (mutations: readonly Mutation[]) => Id;
  readonly exercise: (name: string) => NewRow<"exercise">;
  readonly session: (overrides?: Partial<NewRow<"session">>) => NewRow<"session">;
  readonly entry: (sessionId: Id, exerciseId: Id, position: number) => NewRow<"strength_entry">;
  readonly set: (entryId: Id, position: number, reps: number) => NewRow<"strength_set">;
  readonly weighIn: (localDate: string, grams: number) => NewRow<"weigh_in">;
  readonly checkIn: (localDate: string, energy: number) => NewRow<"check_in">;
  readonly program: (status: "draft" | "active" | "archived") => NewRow<"program">;
  readonly version: (programId: Id, number: number, name: string) => NewRow<"program_version">;
}

export function fixtures(context: TestContext): Fixtures {
  const { env } = context;
  context.db
    .insert(settings)
    .values({
      singleton: 1,
      theme: "dark",
      massUnit: "kg",
      agentCanReadBody: false,
      agentCanWrite: false,
      agentCanReadPhotos: false,
      reminderWeekdays: 0,
      reminderMinutes: 18 * 60 + 30,
      remindersExportedAt: null,
      agentChangesSeenAt: null,
      bridgeHost: null,
      updatedAt: env.now(),
    })
    .onConflictDoNothing()
    .run();
  const occurred = (localDate: string) => ({ occurredAt: env.now(), localDate: localDate as LocalDate, timeZone: "Europe/Paris" });
  return {
    write: (mutations) => commit(context.db, env, { actor: { author: "user", connectionId: null }, summary: "Test", revertsId: null, mutations }),
    exercise: (name) => ({ id: env.newId(), name, nameKey: exerciseNameKey(name), measure: "load_reps", equipment: "barbell", loadMode: "total", baseGrams: null, loadStepGrams: 2500, zonesReviewed: true, mergedIntoId: null, archivedAt: null }),
    session: (overrides = {}) => ({
      id: env.newId(),
      sport: "strength",
      slotId: null,
      variantId: null,
      countsInRotation: false,
      gearId: null,
      title: null,
      status: "completed",
      startedAt: env.now(),
      endedAt: env.now(),
      pausedSeconds: 0,
      localDate: "2026-10-24" as LocalDate,
      timeZone: "Europe/Paris",
      values: {},
      effort: null,
      sensation: null,
      enjoyment: null,
      note: null,
      review: "skipped",
      deletedAt: null,
      ...overrides,
    }),
    entry: (sessionId, exerciseId, position) => ({ id: env.newId(), sessionId, position, exerciseId, programItemId: null, status: "done", note: null }),
    set: (entryId, position, reps) => ({ id: env.newId(), entryId, position, loadGrams: 60000, reps, durationSeconds: null, rir: 2, restBeforeSeconds: null, interrupted: false, completedAt: env.now() as EpochMs }),
    weighIn: (localDate, grams) => ({ id: env.newId(), ...occurred(localDate), grams, deletedAt: null }),
    checkIn: (localDate, energy) => ({ id: env.newId(), ...occurred(localDate), energy, sleep: null, deletedAt: null }),
    program: (status) => ({ id: env.newId(), status }),
    version: (programId, number, name) => ({ id: env.newId(), programId, number, name, sessionsPerWeek: 3, copiedFromId: null, summary: null, reason: null }),
  };
}
