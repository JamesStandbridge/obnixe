import { and, asc, eq, inArray, or, sql } from "drizzle-orm";
import { agentConnection, change, changeset, sessionItem } from "@obnixe/schema";
import type { Author, EpochMs, Id, PainPhase, PainReport, SessionItem, ZoneKey } from "@obnixe/schema";
import type { ObnixeDatabase } from "../database.ts";
import { latestPainByZone, painfulZones } from "./pain.ts";
import { previousPerformance, suggestProgression } from "./progression.ts";
import type { PreviousPerformance, Progression } from "./progression.ts";
import { climbSummary, exerciseOutcome, strengthSummary } from "./summary.ts";
import type { ClimbSummary, ExerciseOutcome, StrengthSummary } from "./summary.ts";
import { loadWorkout } from "./workout.ts";
import type { WorkoutData, WorkoutExercise } from "./workout.ts";

export interface ExerciseReport {
  readonly exercise: WorkoutExercise;
  readonly previous: PreviousPerformance | null;
  readonly progression: Progression;
  readonly outcome: ExerciseOutcome;
}

export type PainAnchor =
  | { readonly kind: "set"; readonly exerciseName: string; readonly setIndex: number }
  | { readonly kind: "item"; readonly itemIndex: number }
  | { readonly kind: "phase"; readonly phase: PainPhase | null };

export interface SessionReport {
  readonly data: WorkoutData;
  readonly items: readonly SessionItem[];
  readonly exercises: readonly ExerciseReport[];
  readonly summary: StrengthSummary;
  readonly climb: ClimbSummary | null;
  readonly painAnchors: ReadonlyMap<Id, PainAnchor>;
}

export function previousFor(db: ObnixeDatabase, data: WorkoutData, target: WorkoutExercise, before: EpochMs): PreviousPerformance | null {
  return previousPerformance(db, { exerciseId: target.exercise.id, itemLineageId: target.item?.lineageId ?? null, before, excludeSessionId: data.session.id });
}

export function progressionFor(target: WorkoutExercise, previous: PreviousPerformance | null, latest: ReadonlyMap<ZoneKey, Pick<PainReport, "level">>): Progression {
  return suggestProgression({
    measure: target.exercise.measure,
    target: target.target,
    stepGrams: target.exercise.loadStepGrams,
    previous: previous?.sets ?? [],
    painful: painfulZones(target.zones, latest).length > 0,
  });
}

export function loadSessionReport(db: ObnixeDatabase, sessionId: Id, now: EpochMs): SessionReport | null {
  const data = loadWorkout(db, sessionId);
  if (data === null) return null;
  const items = db.select().from(sessionItem).where(eq(sessionItem.sessionId, sessionId)).orderBy(asc(sessionItem.position)).all();
  const startedAt = data.session.startedAt;
  const painsAtStart = latestPainByZone(db, (startedAt - 1) as EpochMs);
  const exercises = data.exercises.map((target): ExerciseReport => {
    const previous = previousFor(db, data, target, startedAt);
    const progression = progressionFor(target, previous, painsAtStart);
    return { exercise: target, previous, progression, outcome: exerciseOutcome(target, previous, progression) };
  });
  const painAnchors = new Map<Id, PainAnchor>();
  for (const pain of data.pains) {
    let anchor: PainAnchor = { kind: "phase", phase: pain.phase };
    if (pain.strengthSetId !== null) {
      for (const target of data.exercises) {
        const setIndex = target.sets.findIndex((set) => set.id === pain.strengthSetId);
        if (setIndex !== -1) anchor = { kind: "set", exerciseName: target.exercise.name, setIndex };
      }
    } else if (pain.sessionItemId !== null) {
      const itemIndex = items.findIndex((item) => item.id === pain.sessionItemId);
      if (itemIndex !== -1) anchor = { kind: "item", itemIndex };
    }
    painAnchors.set(pain.id, anchor);
  }
  return {
    data,
    items,
    exercises,
    summary: strengthSummary(data, now),
    climb: data.session.sport === "climb" ? climbSummary(items) : null,
    painAnchors,
  };
}

export interface HistoryEntry {
  readonly changesetId: Id;
  readonly author: Author;
  readonly client: string | null;
  readonly summary: string;
  readonly createdAt: EpochMs;
  readonly creation: boolean;
  readonly reverts: boolean;
  readonly reverted: boolean;
  readonly revertible: boolean;
}

const childTables = ["strength_entry", "session_item", "pain_report"] as const;

export function sessionHistory(db: ObnixeDatabase, sessionId: Id): readonly HistoryEntry[] {
  const ownedBySession = (column: typeof change.after | typeof change.before) => sql`json_extract(${column}, '$.sessionId') = ${sessionId}`;
  const direct = db
    .select({ changesetId: change.changesetId, tableName: change.tableName, rowId: change.rowId })
    .from(change)
    .where(
      or(
        and(eq(change.tableName, "session"), eq(change.rowId, sessionId)),
        and(inArray(change.tableName, [...childTables]), or(ownedBySession(change.after), ownedBySession(change.before))),
      ),
    )
    .all();
  const entryIds = [...new Set(direct.filter((row) => row.tableName === "strength_entry").map((row) => row.rowId))];
  const setChanges =
    entryIds.length === 0
      ? []
      : db
          .select({ changesetId: change.changesetId })
          .from(change)
          .where(
            and(
              eq(change.tableName, "strength_set"),
              or(sql`json_extract(${change.after}, '$.entryId') IN ${entryIds}`, sql`json_extract(${change.before}, '$.entryId') IN ${entryIds}`),
            ),
          )
          .all();
  const ids = [...new Set([...direct, ...setChanges].map((row) => row.changesetId))];
  if (ids.length === 0) return [];
  const rows = db
    .select({ id: changeset.id, author: changeset.author, summary: changeset.summary, createdAt: changeset.createdAt, revertsId: changeset.revertsId, client: agentConnection.client })
    .from(changeset)
    .leftJoin(agentConnection, eq(changeset.connectionId, agentConnection.id))
    .where(inArray(changeset.id, ids))
    .orderBy(asc(changeset.createdAt), asc(changeset.id))
    .all();
  const revertedIds = new Set(db.select({ revertsId: changeset.revertsId }).from(changeset).where(inArray(changeset.revertsId, ids)).all().map((row) => row.revertsId));
  const first = rows[0];
  if (first === undefined) return [];
  const completion = db
    .select({ changesetId: change.changesetId })
    .from(change)
    .innerJoin(changeset, eq(change.changesetId, changeset.id))
    .where(and(eq(change.tableName, "session"), eq(change.rowId, sessionId), sql`json_extract(${change.after}, '$.status') = 'completed'`))
    .orderBy(asc(changeset.createdAt), asc(changeset.id))
    .get();
  const boundary = completion === undefined ? rows.length - 1 : rows.findIndex((row) => row.id === completion.changesetId);
  const creationGroup = rows.slice(0, Math.max(0, boundary) + 1).filter((row) => row.author === first.author);
  const last = creationGroup[creationGroup.length - 1] ?? first;
  const creation: HistoryEntry = {
    changesetId: first.id,
    author: first.author,
    client: first.client,
    summary: first.summary,
    createdAt: last.createdAt,
    creation: true,
    reverts: false,
    reverted: revertedIds.has(first.id),
    revertible: creationGroup.length === 1 && first.author !== "user" && !revertedIds.has(first.id),
  };
  const later = rows
    .filter((row) => !creationGroup.includes(row))
    .map(
      (row): HistoryEntry => ({
        changesetId: row.id,
        author: row.author,
        client: row.client,
        summary: row.summary,
        createdAt: row.createdAt,
        creation: false,
        reverts: row.revertsId !== null,
        reverted: revertedIds.has(row.id),
        revertible: row.revertsId === null && !revertedIds.has(row.id),
      }),
    );
  return [creation, ...later];
}
