import { useMemo } from "react";
import { desc, eq } from "drizzle-orm";
import { useLiveQuery } from "drizzle-orm/expo-sqlite";
import {
  enabledSports,
  exerciseZones,
  lastSessionBySlotLineage,
  latestZonePain,
  listPrograms,
  listVersions,
  loadVersionTree,
  nextSlot,
} from "@obnixe/core";
import type { NextSlot, ProgramEntry, VersionEntry, VersionTree, LatestZonePain } from "@obnixe/core";
import { changeset, exercise, sportPreference } from "@obnixe/schema";
import type { EpochMs, Exercise, Id, SportKey, ZoneKey } from "@obnixe/schema";
import { db, environment } from "@/data/database";
import type { ExerciseName } from "@/features/programs/format";

const painWindowMs = 14 * 86_400_000;

export function useRevision(): string {
  const { data } = useLiveQuery(db().select({ id: changeset.id }).from(changeset).orderBy(desc(changeset.id)).limit(1));
  return data[0]?.id ?? "";
}

export interface ActiveProgram {
  readonly entry: ProgramEntry;
  readonly tree: VersionTree;
  readonly next: NextSlot | null;
  readonly lastDone: ReadonlyMap<Id, EpochMs>;
  readonly versions: readonly VersionEntry[];
}

export interface ProgramsOverview {
  readonly active: ActiveProgram | null;
  readonly others: readonly ProgramEntry[];
}

export function useProgramsOverview(revision: string): ProgramsOverview {
  return useMemo(() => {
    const database = db();
    const programs = listPrograms(database);
    const activeEntry = programs.find((entry) => entry.program.status === "active") ?? null;
    const tree = activeEntry === null ? null : loadVersionTree(database, activeEntry.version.id);
    const others = programs.filter((entry) => entry.program.status !== "active").sort((left, right) => statusRank(left) - statusRank(right));
    if (activeEntry === null || tree === null) return { active: null, others };
    return {
      active: {
        entry: activeEntry,
        tree,
        next: nextSlot(database),
        lastDone: lastSessionBySlotLineage(database, activeEntry.program.id),
        versions: listVersions(database, activeEntry.program.id),
      },
      others,
    };
  }, [revision]);
}

function statusRank(entry: ProgramEntry): number {
  return entry.program.status === "draft" ? 0 : 1;
}

export function useVersions(revision: string, programId: Id | null): readonly VersionEntry[] {
  return useMemo(() => (programId === null ? [] : listVersions(db(), programId)), [revision, programId]);
}

export interface ExerciseCatalog {
  readonly exercises: readonly Exercise[];
  readonly zones: ReadonlyMap<Id, readonly ZoneKey[]>;
  readonly name: ExerciseName;
}

export function useExerciseCatalog(): ExerciseCatalog {
  const { data } = useLiveQuery(db().select().from(exercise));
  const revision = useRevision();
  return useMemo(() => {
    const byId = new Map(data.map((row) => [row.id, row]));
    return { exercises: data, zones: exerciseZones(db()), name: (id: Id) => byId.get(id)?.name ?? "Exercice supprimé" };
  }, [data, revision]);
}

export function useZonePain(revision: string): ReadonlyMap<ZoneKey, LatestZonePain> {
  return useMemo(() => latestZonePain(db(), (environment.now() - painWindowMs) as EpochMs), [revision]);
}

export function useEnabledSports(revision: string): readonly SportKey[] {
  return useMemo(() => enabledSports(db().select().from(sportPreference).all()), [revision]);
}

export function worstPain(exerciseZones: readonly ZoneKey[], pain: ReadonlyMap<ZoneKey, LatestZonePain>): LatestZonePain | null {
  const reports = exerciseZones.map((zone) => pain.get(zone)).filter((value): value is LatestZonePain => value !== undefined);
  return reports.find((report) => report.level === "stop") ?? reports[0] ?? null;
}

export function readExercise(id: Id): Exercise | null {
  return db().select().from(exercise).where(eq(exercise.id, id)).get() ?? null;
}
