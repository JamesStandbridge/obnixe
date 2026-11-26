import { asc, getTableColumns, isNull } from "drizzle-orm";
import type { InferSelectModel } from "drizzle-orm";
import type { SQLiteColumn, SQLiteTable } from "drizzle-orm/sqlite-core";
import { z } from "zod";
import {
  biologicalSexes,
  catalogVersion,
  itemValuesSchema,
  journaled,
  journaledTables,
  mapStyles,
  massUnits,
  photo,
  program,
  rowSchemas,
  session,
  sessionValuesSchema,
  sports,
  targetValuesSchema,
  themes,
  weighIn,
  measurement,
} from "@obnixe/schema";
import type { EpochMs, FieldValues, Id, JournaledTable, RowImage, SportKey } from "@obnixe/schema";
import type { ObnixeDatabase } from "../../database.ts";
import { keyColumnsOf } from "../../keys.ts";
import { readSettings } from "../../settings.ts";
import type { SettingsValues } from "../../settings.ts";
import { columnsOf } from "../foreignKeys.ts";
import { trackDigest } from "../../tracking/codec/track.ts";

export const backupSchemaVersion = 5;

export type TableRow<T extends JournaledTable> = InferSelectModel<(typeof journaled)[T]>;

export type SnapshotTables = { readonly [T in JournaledTable]: readonly TableRow<T>[] };


export interface PhotoFile {
  readonly photoId: Id;
  readonly bytes: Uint8Array;
}

export const trackFileKinds = ["recording", "route"] as const;
export type TrackFileKind = (typeof trackFileKinds)[number];

/** The `.otrk` file of a recording or a route (`DAT-030`), checked against the `track_sha256` of its row before it is restored. */
export interface TrackFile {
  readonly kind: TrackFileKind;
  readonly rowId: Id;
  readonly bytes: Uint8Array;
}

/**
 * A complete copy of the user's data at one instant.
 *
 * The change journal (changeset, change) is deliberately excluded: its before and after images only
 * make sense against the database they were recorded in. After a restore, undo history starts from
 * the restored state; merged rows are journaled again by the import changeset. Agent connections and
 * calls are excluded for the same reason, as are previous backup records.
 */
export interface Snapshot {
  readonly schemaVersion: number;
  readonly catalogVersion: number;
  readonly createdAt: EpochMs;
  readonly tables: SnapshotTables;
  readonly settings: SettingsValues;
  readonly photos: readonly PhotoFile[];
  readonly tracks: readonly TrackFile[];
}

export class CorruptedBackupError extends Error {
  constructor(detail: string) {
    super(`Backup is corrupted: ${detail}`);
  }
}

export class InvalidSnapshotError extends CorruptedBackupError {
  constructor(readonly table: string, readonly index: number, readonly issue: string) {
    super(`${table}[${index}] ${issue}`);
  }
}

/** Agent permissions, the bridge pairing and the rest notification choice belong to this device: importing a backup never grants an agent access. */
export function keepLocalAccess(incoming: SettingsValues, local: SettingsValues): SettingsValues {
  return {
    ...incoming,
    agentCanReadBody: local.agentCanReadBody,
    agentCanWrite: local.agentCanWrite,
    agentCanReadPhotos: local.agentCanReadPhotos,
    agentCanReadLocation: local.agentCanReadLocation,
    bridgeHost: local.bridgeHost,
    restAlertsDeclinedAt: local.restAlertsDeclinedAt,
    restAlertsAskedAt: local.restAlertsAskedAt,
  };
}

export function buildSnapshot(db: ObnixeDatabase, createdAt: EpochMs, photos: readonly PhotoFile[] = [], tracks: readonly TrackFile[] = []): Snapshot {
  const tables: Partial<Record<JournaledTable, readonly RowImage[]>> = {};
  for (const table of journaledTables) {
    const target = journaled[table] as SQLiteTable;
    const columns = getTableColumns(target);
    const order = keyColumnsOf(table).map((name) => asc(columns[name] as SQLiteColumn));
    tables[table] = db.select().from(target).orderBy(...order).all() as RowImage[];
  }
  return { schemaVersion: backupSchemaVersion, catalogVersion, createdAt, tables: tables as unknown as SnapshotTables, settings: readSettings(db), photos, tracks };
}

/** Track files of the snapshot whose bytes match their recording or route row (`DAT-030`), limited to the rows of `rowIds` when given. */
export function restorableTracks(snapshot: Pick<Snapshot, "tables" | "tracks">, rowIds: ReadonlySet<Id> | null): readonly TrackFile[] {
  const recordings = new Map(snapshot.tables.recording.map((row) => [row.id, row.trackSha256]));
  const routes = new Map(snapshot.tables.route.map((row) => [row.id, row.trackSha256]));
  const digestOf = (track: TrackFile): string | null | undefined => {
    switch (track.kind) {
      case "recording":
        return recordings.get(track.rowId);
      case "route":
        return routes.get(track.rowId);
      default: {
        const unreachable: never = track.kind;
        throw new Error(`Unhandled track kind ${String(unreachable)}`);
      }
    }
  };
  return snapshot.tracks.filter((track) => {
    const digest = digestOf(track);
    if (digest === undefined || digest === null || (rowIds !== null && !rowIds.has(track.rowId))) return false;
    return trackDigest(track.bytes) === digest;
  });
}

const settingsSchema = z.object({
  theme: z.enum(themes),
  massUnit: z.enum(massUnits),
  agentCanReadBody: z.boolean(),
  agentCanWrite: z.boolean(),
  agentCanReadPhotos: z.boolean(),
  reminderWeekdays: z.int().min(0).max(127),
  reminderMinutes: z.int().min(0).max(1439),
  remindersExportedAt: z.int().nullable(),
  agentChangesSeenAt: z.int().nullable(),
  bridgeHost: z.string().nullable(),
  restAlertsDeclinedAt: z.custom<EpochMs>((value) => Number.isInteger(value)).nullable(),
  restAlertsAskedAt: z.custom<EpochMs>((value) => Number.isInteger(value)).nullable(),
  agentCanReadLocation: z.boolean(),
  keepScreenOn: z.boolean(),
  countdown: z.boolean(),
  mapStyle: z.enum(mapStyles),
  mapCacheMegabytes: z.int().positive(),
  exportPrivacy: z.boolean(),
  hideTrackEndsMeters: z.int().min(0).max(1000),
  maskInApp: z.boolean(),
  birthYear: z.int().min(1900).max(2100).nullable(),
  sex: z.enum(biologicalSexes).nullable(),
  maxHeartRate: z.int().min(120).max(230).nullable(),
  weatherEnabled: z.boolean(),
  updatedAt: z.int(),
}) satisfies z.ZodType<Omit<SettingsValues, "remindersExportedAt" | "agentChangesSeenAt" | "updatedAt">, unknown>;

export function parseSnapshotSettings(raw: unknown): SettingsValues {
  const parsed = settingsSchema.safeParse(raw);
  if (!parsed.success) throw new InvalidSnapshotError("settings", 0, parsed.error.message);
  return parsed.data as SettingsValues;
}

export function parseSnapshotTables(raw: unknown): SnapshotTables {
  if (raw === null || typeof raw !== "object") throw new CorruptedBackupError("tables missing");
  const source = raw as Record<string, unknown>;
  const tables: Partial<Record<JournaledTable, RowImage[]>> = {};
  for (const table of journaledTables) {
    const rows = source[table] ?? [];
    if (!Array.isArray(rows)) throw new InvalidSnapshotError(table, 0, "is not a list");
    const columns = columnsOf(table);
    tables[table] = rows.map((row: unknown, index) => {
      const parsed = rowSchemas[table].safeParse(row);
      if (!parsed.success) throw new InvalidSnapshotError(table, index, parsed.error.message);
      const data = parsed.data as RowImage;
      return Object.fromEntries(columns.map((column) => [column, data[column] ?? null]));
    });
  }
  const parsed = tables as unknown as SnapshotTables;
  validateCatalogValues(parsed);
  return parsed;
}

function validateCatalogValues(tables: SnapshotTables): void {
  const sessionValues = new Map<string, { readonly sport: SportKey; readonly values: FieldValues }>();
  tables.session.forEach((row, index) => {
    const result = sessionValuesSchema(sports[row.sport]).safeParse(row.values);
    if (!result.success) throw new InvalidSnapshotError("session", index, result.error.message);
    sessionValues.set(row.id, { sport: row.sport, values: row.values });
  });
  tables.session_item.forEach((row, index) => {
    const parent = sessionValues.get(row.sessionId);
    if (parent === undefined) throw new InvalidSnapshotError("session_item", index, "has no session");
    const result = itemValuesSchema(sports[parent.sport], parent.values).safeParse(row.values);
    if (!result.success) throw new InvalidSnapshotError("session_item", index, result.error.message);
  });
  tables.program_slot.forEach((row, index) => {
    const result = targetValuesSchema(sports[row.sport]).safeParse(row.targetValues);
    if (!result.success) throw new InvalidSnapshotError("program_slot", index, result.error.message);
  });
}

export interface SnapshotSummary {
  readonly sessions: number;
  readonly sports: number;
  readonly programs: number;
  readonly bodyEntries: number;
  readonly photos: number;
  readonly coveredFrom: EpochMs | null;
  readonly coveredTo: EpochMs | null;
}

/** Photos count only when their file travels with the backup: a backup exported without photos still lists their rows. */
export function summarizeSnapshot(snapshot: Pick<Snapshot, "tables" | "photos">): SnapshotSummary {
  const { tables } = snapshot;
  const files = new Set(snapshot.photos.map((file) => file.photoId));
  const sessions = tables.session.filter((row) => row.deletedAt === null);
  const weighIns = tables.weigh_in.filter((row) => row.deletedAt === null);
  const measurements = tables.measurement.filter((row) => row.deletedAt === null);
  const checkIns = tables.check_in.filter((row) => row.deletedAt === null);
  const instants = [
    ...sessions.map((row) => row.startedAt),
    ...weighIns.map((row) => row.occurredAt),
    ...measurements.map((row) => row.occurredAt),
    ...checkIns.map((row) => row.occurredAt),
  ];
  return {
    sessions: sessions.length,
    sports: new Set(sessions.map((row) => row.sport)).size,
    programs: tables.program.length,
    bodyEntries: weighIns.length + measurements.length,
    photos: tables.photo.filter((row) => row.deletedAt === null && files.has(row.id)).length,
    coveredFrom: instants.length === 0 ? null : (Math.min(...instants) as EpochMs),
    coveredTo: instants.length === 0 ? null : (Math.max(...instants) as EpochMs),
  };
}

export interface LocalDataSummary {
  readonly sessions: number;
  readonly hasData: boolean;
}

export function localDataSummary(db: ObnixeDatabase): LocalDataSummary {
  const sessions = db.select({ id: session.id }).from(session).where(isNull(session.deletedAt)).all().length;
  const hasOther =
    db.select({ id: program.id }).from(program).limit(1).get() !== undefined ||
    db.select({ id: weighIn.id }).from(weighIn).limit(1).get() !== undefined ||
    db.select({ id: measurement.id }).from(measurement).limit(1).get() !== undefined ||
    db.select({ id: photo.id }).from(photo).limit(1).get() !== undefined ||
    db.select({ id: session.id }).from(session).limit(1).get() !== undefined;
  return { sessions, hasData: sessions > 0 || hasOther };
}
