import { and, asc, count, desc, eq, gte, inArray, isNull, max, min, sql } from "drizzle-orm";
import {
  agentConnection,
  changeset,
  exerciseZone,
  painReport,
  program,
  programItem,
  programSlot,
  programVariant,
  programVersion,
  session,
  strengthEntry,
} from "@obnixe/schema";
import type { Author, EpochMs, Exercise, Id, PainLevel, Program, ProgramVersion, ZoneKey } from "@obnixe/schema";
import type { ObnixeDatabase } from "../database.ts";
import { dayMs } from "../dates.ts";
import type { SlotTree, VersionTree } from "./draft.ts";
import type { ExerciseRef } from "./validate.ts";

export interface VersionAuthor {
  readonly author: Author;
  readonly client: string | null;
  readonly host: string | null;
}

export interface VersionEntry {
  readonly version: ProgramVersion;
  readonly author: VersionAuthor;
  readonly changesetId: Id;
  readonly latest: boolean;
  readonly revertible: boolean;
}

export interface ProgramEntry {
  readonly program: Program;
  readonly version: ProgramVersion;
  readonly author: VersionAuthor;
  readonly slotCount: number;
  readonly completedSessions: number;
  readonly firstSessionAt: EpochMs | null;
  readonly lastSessionAt: EpochMs | null;
}

export interface ExerciseUsage {
  readonly inUse: boolean;
  readonly programNames: readonly string[];
}

export const zonePainWindowMs = 14 * dayMs;

export interface LatestZonePain {
  readonly zone: ZoneKey;
  readonly level: Exclude<PainLevel, "none">;
  readonly occurredAt: EpochMs;
}

export function latestVersion(db: ObnixeDatabase, programId: Id): ProgramVersion | null {
  return db.select().from(programVersion).where(eq(programVersion.programId, programId)).orderBy(desc(programVersion.number)).get() ?? null;
}

export function loadVersionTree(db: ObnixeDatabase, versionId: Id): VersionTree | null {
  const version = db.select().from(programVersion).where(eq(programVersion.id, versionId)).get();
  if (version === undefined) return null;
  const slots = db.select().from(programSlot).where(eq(programSlot.versionId, versionId)).orderBy(asc(programSlot.position)).all();
  const slotIds = slots.map((slot) => slot.id);
  const variants = slotIds.length === 0 ? [] : db.select().from(programVariant).where(inArray(programVariant.slotId, slotIds)).orderBy(asc(programVariant.position)).all();
  const variantIds = variants.map((variant) => variant.id);
  const items = variantIds.length === 0 ? [] : db.select().from(programItem).where(inArray(programItem.variantId, variantIds)).orderBy(asc(programItem.position)).all();
  return {
    version,
    slots: slots.map(
      (slot): SlotTree => ({
        slot,
        variants: variants.filter((variant) => variant.slotId === slot.id).map((variant) => ({ variant, items: items.filter((item) => item.variantId === variant.id) })),
      }),
    ),
  };
}

const authorColumns = { author: changeset.author, client: agentConnection.client, host: agentConnection.host };

export function listVersions(db: ObnixeDatabase, programId: Id): VersionEntry[] {
  const rows = db
    .select({ version: programVersion, ...authorColumns, revertedBy: sql<Id | null>`(SELECT r.id FROM changeset r WHERE r.reverts_id = ${changeset.id})` })
    .from(programVersion)
    .innerJoin(changeset, eq(programVersion.changesetId, changeset.id))
    .leftJoin(agentConnection, eq(changeset.connectionId, agentConnection.id))
    .where(eq(programVersion.programId, programId))
    .orderBy(desc(programVersion.number))
    .all();
  return rows.map((row, index) => ({
    version: row.version,
    author: { author: row.author, client: row.client, host: row.host },
    changesetId: row.version.changesetId,
    latest: index === 0,
    revertible: index === 0 && row.version.number > 1 && row.revertedBy === null,
  }));
}

export function listPrograms(db: ObnixeDatabase): ProgramEntry[] {
  const programs = db.select().from(program).all();
  const versions = db
    .select({ version: programVersion, ...authorColumns })
    .from(programVersion)
    .innerJoin(changeset, eq(programVersion.changesetId, changeset.id))
    .leftJoin(agentConnection, eq(changeset.connectionId, agentConnection.id))
    .orderBy(desc(programVersion.number))
    .all();
  const slotCounts = db.select({ versionId: programSlot.versionId, slots: count() }).from(programSlot).groupBy(programSlot.versionId).all();
  const stats = db
    .select({ programId: programVersion.programId, sessions: count(), first: min(session.startedAt), last: max(session.startedAt) })
    .from(session)
    .innerJoin(programSlot, eq(session.slotId, programSlot.id))
    .innerJoin(programVersion, eq(programSlot.versionId, programVersion.id))
    .where(and(eq(session.status, "completed"), isNull(session.deletedAt)))
    .groupBy(programVersion.programId)
    .all();
  const entries: ProgramEntry[] = [];
  for (const entry of programs) {
    const latest = versions.find((row) => row.version.programId === entry.id);
    if (latest === undefined) continue;
    const stat = stats.find((row) => row.programId === entry.id);
    entries.push({
      program: entry,
      version: latest.version,
      author: { author: latest.author, client: latest.client, host: latest.host },
      slotCount: slotCounts.find((row) => row.versionId === latest.version.id)?.slots ?? 0,
      completedSessions: stat?.sessions ?? 0,
      firstSessionAt: (stat?.first ?? null) as EpochMs | null,
      lastSessionAt: (stat?.last ?? null) as EpochMs | null,
    });
  }
  return entries.sort((left, right) => right.version.createdAt - left.version.createdAt);
}

export function lastSessionBySlotLineage(db: ObnixeDatabase, programId: Id): ReadonlyMap<Id, EpochMs> {
  const rows = db
    .select({ lineageId: programSlot.lineageId, last: max(session.startedAt) })
    .from(session)
    .innerJoin(programSlot, eq(session.slotId, programSlot.id))
    .innerJoin(programVersion, eq(programSlot.versionId, programVersion.id))
    .where(and(eq(programVersion.programId, programId), eq(session.status, "completed"), isNull(session.deletedAt)))
    .groupBy(programSlot.lineageId)
    .all();
  const result = new Map<Id, EpochMs>();
  for (const row of rows) if (row.last !== null) result.set(row.lineageId, row.last as EpochMs);
  return result;
}

export function exerciseRefs(exercises: readonly Exercise[]): ReadonlyMap<Id, ExerciseRef> {
  return new Map(exercises.map((exercise) => [exercise.id, exercise]));
}

export function exerciseUsage(db: ObnixeDatabase, exerciseId: Id): ExerciseUsage {
  const entry = db.select({ id: strengthEntry.id }).from(strengthEntry).where(eq(strengthEntry.exerciseId, exerciseId)).limit(1).get();
  const items = db
    .select({ programId: programVersion.programId, number: programVersion.number })
    .from(programItem)
    .innerJoin(programVariant, eq(programItem.variantId, programVariant.id))
    .innerJoin(programSlot, eq(programVariant.slotId, programSlot.id))
    .innerJoin(programVersion, eq(programSlot.versionId, programVersion.id))
    .where(eq(programItem.exerciseId, exerciseId))
    .all();
  const names: string[] = [];
  for (const entryProgram of listPrograms(db)) {
    if (entryProgram.program.status === "archived") continue;
    if (items.some((item) => item.programId === entryProgram.program.id && item.number === entryProgram.version.number)) names.push(entryProgram.version.name);
  }
  return { inUse: entry !== undefined || items.length > 0, programNames: names };
}

export function exerciseZones(db: ObnixeDatabase): ReadonlyMap<Id, readonly ZoneKey[]> {
  const zones = new Map<Id, ZoneKey[]>();
  for (const row of db.select().from(exerciseZone).all()) {
    const list = zones.get(row.exerciseId) ?? [];
    list.push(row.zone);
    zones.set(row.exerciseId, list);
  }
  return zones;
}

export function latestZonePain(db: ObnixeDatabase, since: EpochMs): ReadonlyMap<ZoneKey, LatestZonePain> {
  const rows = db
    .select({ zone: painReport.zone, level: painReport.level, occurredAt: painReport.occurredAt })
    .from(painReport)
    .where(and(gte(painReport.occurredAt, since), isNull(painReport.deletedAt)))
    .orderBy(asc(painReport.occurredAt))
    .all();
  const latest = new Map<ZoneKey, LatestZonePain>();
  for (const row of rows) {
    if (row.level === "none") latest.delete(row.zone);
    else latest.set(row.zone, { zone: row.zone, level: row.level, occurredAt: row.occurredAt });
  }
  return latest;
}

export function worstPain(exerciseZones: readonly ZoneKey[], pain: ReadonlyMap<ZoneKey, LatestZonePain>): LatestZonePain | null {
  const reports = exerciseZones.map((zone) => pain.get(zone)).filter((value): value is LatestZonePain => value !== undefined);
  return reports.find((report) => report.level === "stop") ?? reports[0] ?? null;
}
