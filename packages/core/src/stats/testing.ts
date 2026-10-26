import { agentConnection } from "@obnixe/schema";
import type { Effort, EpochMs, ExerciseMeasure, FieldValues, Id, LocalDate, PainLevel, ReviewStatus, SessionStatus, SportKey, ZoneKey } from "@obnixe/schema";
import { exerciseNameKey } from "@obnixe/schema";
import type { TestContext } from "../testing.ts";
import { commit } from "../writer.ts";
import type { Actor, Mutation } from "../writer.ts";

export const userActor: Actor = { author: "user", connectionId: null };

export function at(date: string, time = "10:00"): EpochMs {
  return Date.parse(`${date}T${time}:00Z`) as EpochMs;
}

export class Seeder {
  constructor(readonly context: TestContext) {}

  write(mutations: readonly Mutation[], actor: Actor = userActor): Id {
    return commit(this.context.db, this.context.env, { actor, summary: "Seed", revertsId: null, mutations });
  }

  id(): Id {
    return this.context.env.newId();
  }

  exercise(name: string, measure: ExerciseMeasure = "load_reps", zones: readonly ZoneKey[] = []): Id {
    const id = this.id();
    this.write([
      {
        kind: "insert",
        table: "exercise",
        row: { id, name, nameKey: exerciseNameKey(name), measure, equipment: measure === "load_reps" ? "barbell" : "bodyweight", loadStepGrams: null, zonesReviewed: true, mergedIntoId: null, archivedAt: null },
      },
      ...zones.map((zone): Mutation => ({ kind: "insert", table: "exercise_zone", row: { exerciseId: id, zone } })),
    ]);
    return id;
  }

  program(name: string, sessionsPerWeek: number, slots: readonly SlotSeed[]): ProgramSeed {
    const programId = this.id();
    const versionId = this.id();
    const slotIds: Id[] = [];
    const variantIds: Id[][] = [];
    const mutations: Mutation[] = [
      { kind: "insert", table: "program", row: { id: programId, status: "active" } },
      { kind: "insert", table: "program_version", row: { id: versionId, programId, number: 1, name, sessionsPerWeek, copiedFromId: null, summary: null, reason: null } },
    ];
    slots.forEach((slot, position) => {
      const slotId = this.id();
      slotIds.push(slotId);
      mutations.push({
        kind: "insert",
        table: "program_slot",
        row: { id: slotId, versionId, lineageId: this.id(), position, sport: slot.sport, name: slot.name, targetDurationSeconds: slot.targetDurationSeconds ?? null, targetEffort: null, targetValues: {} },
      });
      const ids: Id[] = [];
      (slot.variants ?? []).forEach((variant, variantPosition) => {
        const variantId = this.id();
        ids.push(variantId);
        mutations.push({ kind: "insert", table: "program_variant", row: { id: variantId, slotId, lineageId: this.id(), position: variantPosition, name: variant.name } });
        variant.items.forEach((item, itemPosition) => {
          mutations.push({
            kind: "insert",
            table: "program_item",
            row: {
              id: this.id(),
              variantId,
              lineageId: this.id(),
              position: itemPosition,
              exerciseId: item.exerciseId,
              sets: item.sets,
              repsMin: item.reps?.[0] ?? null,
              repsMax: item.reps?.[1] ?? null,
              durationMinSeconds: item.duration?.[0] ?? null,
              durationMaxSeconds: item.duration?.[1] ?? null,
              targetRir: 2,
              restSeconds: item.restSeconds ?? null,
              restAfterSeconds: null,
            },
          });
        });
      });
      variantIds.push(ids);
    });
    this.write(mutations);
    return { programId, versionId, slotIds, variantIds };
  }

  session(seed: SessionSeed, actor: Actor = userActor): Id {
    const id = this.id();
    const startedAt = seed.startedAt ?? at(seed.date);
    const status = seed.status ?? "completed";
    const endedAt = status === "in_progress" ? null : ((startedAt + (seed.minutes ?? 60) * 60_000) as EpochMs);
    const mutations: Mutation[] = [
      {
        kind: "insert",
        table: "session",
        row: {
          id,
          sport: seed.sport,
          slotId: seed.slotId ?? null,
          variantId: seed.variantId ?? null,
          countsInRotation: seed.slotId !== undefined,
          gearId: null,
          title: seed.title ?? null,
          status,
          startedAt,
          endedAt,
          pausedSeconds: 0,
          localDate: seed.date as LocalDate,
          timeZone: "Europe/Paris",
          values: seed.values ?? {},
          effort: seed.effort ?? null,
          sensation: null,
          enjoyment: null,
          note: null,
          review: seed.review ?? "done",
          deletedAt: seed.deleted === true ? startedAt : null,
        },
      },
    ];
    (seed.items ?? []).forEach((values, position) => {
      mutations.push({ kind: "insert", table: "session_item", row: { id: this.id(), sessionId: id, position, values, recordedAt: startedAt } });
    });
    (seed.entries ?? []).forEach((entry, position) => {
      const entryId = this.id();
      mutations.push({ kind: "insert", table: "strength_entry", row: { id: entryId, sessionId: id, position, exerciseId: entry.exerciseId, programItemId: null, status: "done", note: null } });
      entry.sets.forEach((set, setPosition) => {
        mutations.push({
          kind: "insert",
          table: "strength_set",
          row: {
            id: this.id(),
            entryId,
            position: setPosition,
            loadGrams: set.kg === null ? null : Math.round(set.kg * 1000),
            reps: set.reps ?? null,
            durationSeconds: set.seconds ?? null,
            rir: set.rir ?? null,
            restBeforeSeconds: null,
            interrupted: set.interrupted ?? false,
            completedAt: (startedAt + (position * 10 + setPosition + 1) * 60_000) as EpochMs,
          },
        });
      });
    });
    for (const pain of seed.pains ?? []) {
      mutations.push({
        kind: "insert",
        table: "pain_report",
        row: {
          id: this.id(),
          zone: pain.zone,
          level: pain.level,
          occurredAt: startedAt,
          localDate: seed.date as LocalDate,
          timeZone: "Europe/Paris",
          sessionId: id,
          phase: "end",
          strengthSetId: null,
          sessionItemId: null,
          checkInId: null,
          note: null,
          deletedAt: null,
        },
      });
    }
    this.write(mutations, actor);
    return id;
  }

  checkIn(date: string, energy: number | null, zones: readonly { readonly zone: ZoneKey; readonly level: PainLevel }[] = []): Id {
    const id = this.id();
    const occurredAt = at(date, "07:00");
    this.write([
      { kind: "insert", table: "check_in", row: { id, occurredAt, localDate: date as LocalDate, timeZone: "Europe/Paris", energy, sleep: "h7", deletedAt: null } },
      ...zones.map(
        (zone): Mutation => ({
          kind: "insert",
          table: "pain_report",
          row: {
            id: this.id(),
            zone: zone.zone,
            level: zone.level,
            occurredAt,
            localDate: date as LocalDate,
            timeZone: "Europe/Paris",
            sessionId: null,
            phase: null,
            strengthSetId: null,
            sessionItemId: null,
            checkInId: id,
            note: null,
            deletedAt: null,
          },
        }),
      ),
    ]);
    return id;
  }

  agent(client: string): Actor {
    const id = this.id();
    this.context.db
      .insert(agentConnection)
      .values({ id, client, host: "mac", startedAt: this.context.env.now(), endedAt: null, endReason: null })
      .run();
    return { author: "agent", connectionId: id };
  }
}

export interface ItemSeed {
  readonly exerciseId: Id;
  readonly sets: number;
  readonly reps?: readonly [number, number];
  readonly duration?: readonly [number, number];
  readonly restSeconds?: number;
}

export interface SlotSeed {
  readonly sport: SportKey;
  readonly name: string;
  readonly targetDurationSeconds?: number;
  readonly variants?: readonly { readonly name: string; readonly items: readonly ItemSeed[] }[];
}

export interface ProgramSeed {
  readonly programId: Id;
  readonly versionId: Id;
  readonly slotIds: readonly Id[];
  readonly variantIds: readonly (readonly Id[])[];
}

export interface SetSeed {
  readonly kg: number | null;
  readonly reps?: number;
  readonly seconds?: number;
  readonly rir?: number;
  readonly interrupted?: boolean;
}

export interface SessionSeed {
  readonly sport: SportKey;
  readonly date: string;
  readonly startedAt?: EpochMs;
  readonly minutes?: number;
  readonly status?: SessionStatus;
  readonly review?: ReviewStatus;
  readonly title?: string;
  readonly slotId?: Id;
  readonly variantId?: Id;
  readonly values?: FieldValues;
  readonly items?: readonly FieldValues[];
  readonly effort?: Effort;
  readonly entries?: readonly { readonly exerciseId: Id; readonly sets: readonly SetSeed[] }[];
  readonly pains?: readonly { readonly zone: ZoneKey; readonly level: PainLevel }[];
  readonly deleted?: boolean;
}
