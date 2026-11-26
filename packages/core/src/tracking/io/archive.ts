import { inArray } from "drizzle-orm";
import { session } from "@obnixe/schema";
import type { EpochMs, Id, SportKey } from "@obnixe/schema";
import { importActor } from "../../data/backup/merge.ts";
import type { Environment, ObnixeDatabase } from "../../database.ts";
import { revert } from "../../undo.ts";
import type { RevertRequest } from "../../undo.ts";
import { commit } from "../../writer.ts";
import type { Mutation } from "../../writer.ts";
import type { ArchiveFormat, ImportedActivity } from "./activity.ts";
import { ImportError } from "./errors.ts";
import type { ImportErrorReason } from "./errors.ts";
import { computeImport, duplicateStartMs, findImportDuplicate, importDistanceMm, importHolder, planImport, withinDuplicateDistance } from "./import.ts";
import type { ImportComputation, ImportTrackFile } from "./import.ts";
import { maxActivityFileBytes, readActivityFile } from "./zip.ts";
import { ArchiveError, readZipEntry } from "./zipArchive.ts";
import type { ArchiveErrorReason, ArchiveSource, Pace, ZipEntry } from "./zipArchive.ts";

const archiveSummaries: Readonly<Record<ArchiveFormat, string>> = { garmin_archive: "Import de l'archive Garmin Connect" };

/** Activities committed per changeset of author `import` (`IO-025`). */
export const archiveBatchSize = 20;
/** Work done before the import yields to the interface: with steps shorter than it, a slice stays under a 16 ms frame (`IO-026`). */
export const archiveSliceMs = 8;

/** The summary of every changeset of an archive import. */
export function archiveImportSummary(format: ArchiveFormat): string {
  return archiveSummaries[format];
}

/** An activity file of an archive, read when its turn comes. */
export interface ArchiveFile {
  readonly path: string;
  readonly source: ArchiveSource;
  readonly entry: ZipEntry;
}

/** What an archive says of one of its activities beyond the file: the identity it gives it (`DAT-031`) and its title. */
export interface ArchiveIdentity {
  readonly externalId: string;
  readonly title: string | null;
}

export type ArchiveRefusalReason = ImportErrorReason | ArchiveErrorReason;

export interface ArchiveRefusal {
  readonly path: string;
  readonly reason: ArchiveRefusalReason;
}

/** An account archive opened for import (`IO-053`): its files, read one at a time, and the identity it gives each activity. */
export interface OpenedArchive {
  readonly format: ArchiveFormat;
  readonly files: readonly ArchiveFile[];
  /** Nested archives that could not be listed. */
  readonly refused: readonly ArchiveRefusal[];
  identify(activity: ImportedActivity): ArchiveIdentity;
  /** Discards the scratch files of the nested archives. */
  close(): Promise<void>;
}

/** A temporary file holding a compressed nested archive, inflated so that it is read by ranges too (`IO-021`). */
export interface ScratchFile {
  append(bytes: Uint8Array): Promise<void>;
  /** Ends the writing; the file is then read through the returned source until it is discarded. */
  finish(): Promise<ArchiveSource>;
  discard(): Promise<void>;
}

export type ScratchSpace = () => Promise<ScratchFile>;

export interface ArchiveProgress {
  readonly done: number;
  readonly total: number;
}

/** How a long archive task shares the JavaScript thread, reports its progress and learns that the user stopped it. */
export interface ArchiveControl {
  readonly pace: Pace;
  readonly stopped: () => boolean;
  readonly onProgress: (progress: ArchiveProgress) => void;
}

export class ArchiveStoppedError extends Error {
  constructor() {
    super("The archive task was stopped");
  }
}

/**
 * `IO-026` without a worklet runtime: the work runs in slices that yield to the interface once `budgetMs` has elapsed, so a
 * slice lasts the budget plus at most one step.
 */
export function slicedPace(now: () => number, budgetMs: number): Pace {
  let sliceStart = now();
  return async () => {
    if (now() - sliceStart < budgetMs) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    sliceStart = now();
  };
}

/** A probable duplicate (`IO-012`): of sessions in the journal, or of an activity met earlier in the same archive. */
export type ArchiveDuplicate = { readonly kind: "none" } | { readonly kind: "journal"; readonly sessionIds: readonly Id[] } | { readonly kind: "archive" };

type ArchiveItem =
  | { readonly kind: "other" }
  | { readonly kind: "refused"; readonly reason: ArchiveRefusalReason }
  | { readonly kind: "unsupported" }
  | { readonly kind: "already_imported" }
  | { readonly kind: "importable"; readonly computation: ImportComputation; readonly duplicate: ArchiveDuplicate };

/** Files an account archive holds besides activities: monitoring, sleep or course FIT files, routes, other documents. */
const otherFileReasons: ReadonlySet<ImportErrorReason> = new Set(["not_an_activity", "unsupported_format", "untimed"]);

interface ArchiveActivity {
  readonly sport: SportKey;
  readonly startedAt: EpochMs;
  readonly distanceMm: number;
}

/** Reads and measures the files of an archive in order, remembering what it met so that the archive never duplicates itself. */
class ArchiveScan {
  private readonly externalIds = new Set<string>();
  private readonly activities: ArchiveActivity[] = [];
  /** Sessions created by this import: a later activity like one of them duplicates the archive and never replaces it. */
  readonly created = new Set<Id>();

  constructor(
    private readonly db: ObnixeDatabase,
    private readonly archive: OpenedArchive,
  ) {}

  async item(file: ArchiveFile): Promise<ArchiveItem> {
    let bytes: Uint8Array;
    try {
      bytes = await readZipEntry(file.source, file.entry, maxActivityFileBytes);
    } catch (error) {
      if (error instanceof ArchiveError) return { kind: "refused", reason: error.reason };
      throw error;
    }
    let activity: ImportedActivity;
    try {
      activity = readActivityFile(bytes);
    } catch (error) {
      if (!(error instanceof ImportError)) throw error;
      return otherFileReasons.has(error.reason) ? { kind: "other" } : { kind: "refused", reason: error.reason };
    }
    return this.measure(activity);
  }

  /** `IO-024`: an activity whose archive identity or file identity is held in force, or met before in the archive, is skipped. */
  private measure(activity: ImportedActivity): ArchiveItem {
    if (activity.sport === null) return { kind: "unsupported" };
    const identity = this.archive.identify(activity);
    if (this.externalIds.has(identity.externalId) || importHolder(this.db, identity.externalId) !== null || importHolder(this.db, activity.externalId) !== null) return { kind: "already_imported" };
    this.externalIds.add(identity.externalId);
    const computation = computeImport({ ...activity, externalId: identity.externalId, name: identity.title }, activity.sport);
    const measured: ArchiveActivity = { sport: activity.sport.sport, startedAt: activity.startedAt, distanceMm: importDistanceMm(computation) };
    const duplicate = this.duplicateOf(computation, measured);
    this.activities.push(measured);
    return { kind: "importable", computation, duplicate };
  }

  private duplicateOf(computation: ImportComputation, measured: ArchiveActivity): ArchiveDuplicate {
    const found = findImportDuplicate(this.db, computation);
    const probable = found.kind === "probable" ? found.sessionIds : [];
    const journal = probable.filter((id) => !this.created.has(id));
    if (journal.length > 0) return { kind: "journal", sessionIds: journal };
    const twin = this.activities.some(
      (earlier) => earlier.sport === measured.sport && Math.abs(earlier.startedAt - measured.startedAt) <= duplicateStartMs && withinDuplicateDistance(measured.distanceMm, earlier.distanceMm),
    );
    return probable.length > 0 || twin ? { kind: "archive" } : { kind: "none" };
  }
}

export interface ArchiveSportCount {
  readonly sport: SportKey;
  readonly count: number;
}

/** What an archive would bring (`IO-020`): activities per sport, period, duplicates, and what is skipped or refused. */
export interface ArchivePreview {
  /** Importable activities per sport, duplicates included, most practiced first. */
  readonly sports: readonly ArchiveSportCount[];
  readonly importable: number;
  readonly duplicates: number;
  readonly firstStartedAt: EpochMs | null;
  readonly lastStartedAt: EpochMs | null;
  readonly alreadyImported: number;
  /** Activities of sports Obnixe does not know. */
  readonly unsupported: number;
  readonly refused: readonly ArchiveRefusal[];
  /** Indices in `OpenedArchive.files` of the importable activities: the import reads only them again. */
  readonly candidates: readonly number[];
}

/** Reads and measures every file of the archive without writing anything; throws `ArchiveStoppedError` when stopped. */
export async function previewArchive(db: ObnixeDatabase, archive: OpenedArchive, control: ArchiveControl): Promise<ArchivePreview> {
  const scan = new ArchiveScan(db, archive);
  const counts = new Map<SportKey, number>();
  const refused: ArchiveRefusal[] = [...archive.refused];
  const candidates: number[] = [];
  let duplicates = 0;
  let alreadyImported = 0;
  let unsupported = 0;
  let firstStartedAt: EpochMs | null = null;
  let lastStartedAt: EpochMs | null = null;
  for (const [index, file] of archive.files.entries()) {
    if (control.stopped()) throw new ArchiveStoppedError();
    const item = await scan.item(file);
    switch (item.kind) {
      case "other":
        break;
      case "refused":
        refused.push({ path: file.path, reason: item.reason });
        break;
      case "unsupported":
        unsupported += 1;
        break;
      case "already_imported":
        alreadyImported += 1;
        break;
      case "importable": {
        const { sport, activity } = item.computation;
        candidates.push(index);
        counts.set(sport.sport, (counts.get(sport.sport) ?? 0) + 1);
        if (item.duplicate.kind !== "none") duplicates += 1;
        if (firstStartedAt === null || activity.startedAt < firstStartedAt) firstStartedAt = activity.startedAt;
        if (lastStartedAt === null || activity.startedAt > lastStartedAt) lastStartedAt = activity.startedAt;
        break;
      }
      default: {
        const unreachable: never = item;
        throw new Error(`Unhandled archive item ${JSON.stringify(unreachable)}`);
      }
    }
    control.onProgress({ done: index + 1, total: archive.files.length });
    await control.pace();
  }
  const sports = [...counts].map(([sport, count]): ArchiveSportCount => ({ sport, count })).sort((left, right) => right.count - left.count);
  return { sports, importable: candidates.length, duplicates, firstStartedAt, lastStartedAt, alreadyImported, unsupported, refused, candidates };
}

/** What to do with the probable duplicates of an archive (`IO-012`): ignore them (default), replace the session, or keep both. */
export type ArchiveDuplicatePolicy = "ignore" | "replace" | "keep";

export interface ArchiveImportRequest {
  readonly preview: ArchivePreview;
  readonly duplicates: ArchiveDuplicatePolicy;
  readonly timeZone: string;
}

export interface ArchiveImportHost extends ArchiveControl {
  readonly db: ObnixeDatabase;
  readonly env: Environment;
  /** Writes and syncs a track before the batch that references it is committed (`DAT-020`). */
  readonly writeTrack: (recordingId: Id, track: ImportTrackFile) => Promise<void>;
}

export interface ArchiveBatch {
  readonly changesetId: Id;
  readonly sessionIds: readonly Id[];
  readonly trackFiles: readonly string[];
}

/** The final report of an archive import (`IO-020`), and what *Annuler l'import* undoes (`IO-025`). */
export interface ArchiveImportReport {
  readonly format: ArchiveFormat;
  /** Sessions created, replacements included. */
  readonly imported: number;
  readonly replaced: number;
  /** Activities already imported, ignored duplicates and activities of unknown sports. */
  readonly skipped: number;
  readonly refused: readonly ArchiveRefusal[];
  readonly batches: readonly ArchiveBatch[];
  /** The user stopped the import: the activities before the stop are imported. */
  readonly stopped: boolean;
}

function closestSession(db: ObnixeDatabase, sessionIds: readonly Id[], startedAt: EpochMs): Id | null {
  if (sessionIds.length === 0) return null;
  const rows = db.select({ id: session.id, startedAt: session.startedAt }).from(session).where(inArray(session.id, [...sessionIds])).all();
  return rows.reduce<{ readonly id: Id; readonly startedAt: EpochMs } | null>((best, row) => (best === null || Math.abs(row.startedAt - startedAt) < Math.abs(best.startedAt - startedAt) ? row : best), null)?.id ?? null;
}

interface ImportChoice {
  readonly replaceSessionId: Id | null;
}

class PendingBatch {
  readonly mutations: Mutation[] = [];
  readonly sessionIds: Id[] = [];
  readonly trackFiles: string[] = [];
}

/**
 * Imports the candidates of a preview by batches of `archiveBatchSize` activities, each one changeset of author `import`
 * (`IO-025`), every track written before its batch (`DAT-020`). Each activity is measured again, so that what changed since the
 * preview is respected: never twice the same activity (`IO-024`), duplicates settled by the policy (`IO-012`). When stopped,
 * the activities already planned are committed and the report says so.
 */
export async function importArchive(archive: OpenedArchive, request: ArchiveImportRequest, host: ArchiveImportHost): Promise<ArchiveImportReport> {
  const scan = new ArchiveScan(host.db, archive);
  const replacedIds = new Set<Id>();
  const batches: ArchiveBatch[] = [];
  const refused: ArchiveRefusal[] = [...request.preview.refused];
  let pending = new PendingBatch();
  let imported = 0;
  let skipped = 0;
  let stopped = false;

  const choose = (computation: ImportComputation, duplicate: ArchiveDuplicate): ImportChoice | null => {
    switch (duplicate.kind) {
      case "none":
        return { replaceSessionId: null };
      case "archive":
        return request.duplicates === "keep" ? { replaceSessionId: null } : null;
      case "journal": {
        if (request.duplicates === "ignore") return null;
        if (request.duplicates === "keep") return { replaceSessionId: null };
        const replaceSessionId = closestSession(
          host.db,
          duplicate.sessionIds.filter((id) => !replacedIds.has(id)),
          computation.activity.startedAt,
        );
        return replaceSessionId === null ? null : { replaceSessionId };
      }
      default: {
        const unreachable: never = duplicate;
        throw new Error(`Unhandled archive duplicate ${JSON.stringify(unreachable)}`);
      }
    }
  };

  const flush = (): void => {
    if (pending.sessionIds.length === 0) return;
    const changesetId = commit(host.db, host.env, { actor: importActor, summary: archiveImportSummary(archive.format), revertsId: null, mutations: pending.mutations });
    batches.push({ changesetId, sessionIds: pending.sessionIds, trackFiles: pending.trackFiles });
    pending = new PendingBatch();
  };

  for (const [position, index] of request.preview.candidates.entries()) {
    if (host.stopped()) {
      stopped = true;
      break;
    }
    const file = archive.files[index];
    if (file === undefined) throw new RangeError(`The preview names file ${index}, absent from the archive`);
    const item = await scan.item(file);
    switch (item.kind) {
      case "other":
      case "unsupported":
      case "already_imported":
        skipped += 1;
        break;
      case "refused":
        refused.push({ path: file.path, reason: item.reason });
        break;
      case "importable": {
        const choice = choose(item.computation, item.duplicate);
        if (choice === null) {
          skipped += 1;
          break;
        }
        const plan = planImport(host.db, host.env, { computation: item.computation, timeZone: request.timeZone, replaceSessionId: choice.replaceSessionId, archiveFormat: archive.format });
        if (plan.track !== null) {
          await host.writeTrack(plan.recordingId, plan.track);
          pending.trackFiles.push(plan.track.path);
        }
        pending.mutations.push(...plan.request.mutations);
        pending.sessionIds.push(plan.sessionId);
        scan.created.add(plan.sessionId);
        if (choice.replaceSessionId !== null) replacedIds.add(choice.replaceSessionId);
        imported += 1;
        if (pending.sessionIds.length >= archiveBatchSize) flush();
        break;
      }
      default: {
        const unreachable: never = item;
        throw new Error(`Unhandled archive item ${JSON.stringify(unreachable)}`);
      }
    }
    host.onProgress({ done: position + 1, total: request.preview.candidates.length });
    await host.pace();
  }
  flush();
  return { format: archive.format, imported, replaced: replacedIds.size, skipped, refused, batches, stopped };
}

/**
 * *Annuler l'import* (`IO-025`): reverts every batch, newest first, in one transaction, so that a conflict with a later edit
 * leaves the import whole. Returns the track files the import wrote, to delete once reverted.
 */
export function undoArchiveImport(db: ObnixeDatabase, env: Environment, report: ArchiveImportReport, request: Omit<RevertRequest, "changesetId">): readonly string[] {
  db.transaction((tx) => {
    for (const batch of [...report.batches].reverse()) revert(tx, env, { ...request, changesetId: batch.changesetId });
  });
  return report.batches.flatMap((batch) => batch.trackFiles);
}
