import { z } from "zod";
import { decodeUtf8, InvalidUtf8Error } from "../../data/utf8.ts";
import type { ImportedActivity } from "./activity.ts";
import { ArchiveStoppedError } from "./archive.ts";
import type { ArchiveControl, ArchiveFile, ArchiveIdentity, ArchiveRefusal, OpenedArchive, ScratchFile, ScratchSpace } from "./archive.ts";
import { ArchiveError, isZipDirectory, readZipDirectory, readZipEntry, storedEntrySource, streamZipEntry } from "./zipArchive.ts";
import type { ArchiveSource, Pace, ZipEntry } from "./zipArchive.ts";

/** Gap under which an activity of the account summaries and a file starting then are the same activity. */
export const garminStartToleranceMs = 60_000;

/** The original files: `DI-Connect-Uploaded-Files`, named `DI-Connect-Fitness-Uploaded-Files` in some exports. */
const uploadedFiles = /(?:^|\/)DI-Connect-(?:Fitness-)?Uploaded-Files\//;
const activitySummaries = /(?:^|\/)DI-Connect-Fitness\/[^/]*summarizedActivities\.json$/;
const nestedArchive = /\.zip$/i;
const maxSummaryBytes = 64 * 1024 * 1024;

const summariesSchema = z.array(
  z.object({
    summarizedActivitiesExport: z.array(
      z.object({
        activityId: z.number().int().nonnegative(),
        name: z.string().nullish(),
        beginTimestamp: z.number().nullish(),
        startTimeGmt: z.number().nullish(),
      }),
    ),
  }),
);

interface GarminActivity {
  readonly id: number;
  readonly name: string | null;
  readonly startedAt: number;
}

/** The activities listed by a `*_summarizedActivities.json` file, with the precise start when given. */
function readSummaries(bytes: Uint8Array, path: string): GarminActivity[] {
  let json: unknown;
  try {
    json = JSON.parse(decodeUtf8(bytes));
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof InvalidUtf8Error) throw new ArchiveError("malformed", `${path} is not JSON`);
    throw error;
  }
  const parsed = summariesSchema.safeParse(json);
  if (!parsed.success) throw new ArchiveError("malformed", `${path} does not list activities`);
  return parsed.data.flatMap((part) =>
    part.summarizedActivitiesExport.flatMap((activity): GarminActivity[] => {
      const startedAt = activity.beginTimestamp ?? activity.startTimeGmt;
      return startedAt === null || startedAt === undefined ? [] : [{ id: activity.activityId, name: activity.name?.trim() || null, startedAt: Math.round(startedAt) }];
    }),
  );
}

/** The summary starting closest to `startedAt` within the tolerance, by bisection of the summaries sorted by start. */
function nearest(sorted: readonly GarminActivity[], startedAt: number): GarminActivity | null {
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if ((sorted[middle]?.startedAt ?? 0) < startedAt) low = middle + 1;
    else high = middle;
  }
  const around = [sorted[low - 1], sorted[low]].filter((activity): activity is GarminActivity => activity !== undefined && Math.abs(activity.startedAt - startedAt) <= garminStartToleranceMs);
  return around.reduce<GarminActivity | null>((best, activity) => (best === null || Math.abs(activity.startedAt - startedAt) < Math.abs(best.startedAt - startedAt) ? activity : best), null);
}

/** `garmin:<activityId>` and the Garmin Connect title when a summary starts with the file; the file's own identity otherwise. */
function identify(sorted: readonly GarminActivity[], activity: ImportedActivity): ArchiveIdentity {
  const match = nearest(sorted, activity.startedAt);
  return match === null ? { externalId: activity.externalId, title: activity.name } : { externalId: `garmin:${match.id}`, title: match.name ?? activity.name };
}

/**
 * Opens a Garmin Connect account export (`IO-053`). The summaries of `DI_CONNECT/DI-Connect-Fitness/` give each activity its id
 * and title; the original files lie under `DI_CONNECT/DI-Connect-Uploaded-Files/`, loose or in `UploadedFiles_*.zip` archives.
 * A nested archive kept uncompressed is read in place; a compressed one is inflated into a scratch file, then read by ranges.
 */
export async function openGarminArchive(source: ArchiveSource, scratch: ScratchSpace, control: ArchiveControl): Promise<OpenedArchive> {
  const entries = await readZipDirectory(source);
  const uploaded = entries.filter((entry) => uploadedFiles.test(entry.path) && !isZipDirectory(entry));
  if (uploaded.length === 0) throw new ArchiveError("not_an_account_archive", "the archive has no DI-Connect-Uploaded-Files folder");
  const summaries: GarminActivity[] = [];
  for (const entry of entries) if (activitySummaries.test(entry.path)) summaries.push(...readSummaries(await readZipEntry(source, entry, maxSummaryBytes), entry.path));
  summaries.sort((left, right) => left.startedAt - right.startedAt);

  const nested = uploaded.filter((entry) => nestedArchive.test(entry.path));
  const total = nested.reduce((sum, entry) => sum + entry.compressedSize, 0);
  const scratchFiles: ScratchFile[] = [];
  const files: ArchiveFile[] = uploaded.filter((entry) => !nestedArchive.test(entry.path)).map((entry) => ({ path: entry.path, source, entry }));
  const refused: ArchiveRefusal[] = [];
  let done = 0;
  const pace: Pace = async () => {
    if (control.stopped()) throw new ArchiveStoppedError();
    await control.pace();
  };
  const inflated = async (entry: ZipEntry): Promise<ArchiveSource> => {
    const file = await scratch();
    scratchFiles.push(file);
    await streamZipEntry(
      source,
      entry,
      async (chunk, compressedRead) => {
        await file.append(chunk);
        control.onProgress({ done: done + compressedRead, total });
      },
      pace,
    );
    return file.finish();
  };
  const discard = async (): Promise<void> => {
    for (const file of scratchFiles.splice(0)) await file.discard();
  };

  try {
    for (const entry of nested) {
      await pace();
      try {
        const inner = (await storedEntrySource(source, entry)) ?? (await inflated(entry));
        for (const innerEntry of await readZipDirectory(inner)) if (!isZipDirectory(innerEntry)) files.push({ path: `${entry.path}/${innerEntry.path}`, source: inner, entry: innerEntry });
      } catch (error) {
        if (!(error instanceof ArchiveError)) throw error;
        refused.push({ path: entry.path, reason: error.reason });
      }
      done += entry.compressedSize;
      control.onProgress({ done, total });
    }
  } catch (error) {
    await discard();
    throw error;
  }
  return { format: "garmin_archive", files, refused, identify: (activity) => identify(summaries, activity), close: discard };
}
