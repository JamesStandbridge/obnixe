import { gunzipSync, unzipSync } from "fflate";
import type { ImportedActivity } from "./activity.ts";
import { ImportError } from "./errors.ts";
import { readFit } from "./fit.ts";
import { readGpx } from "./gpx.ts";
import { readTcx } from "./tcx.ts";

/** Larger activity files are refused rather than inflated: a day at 1 Hz is far below. */
export const maxActivityFileBytes = 64 * 1024 * 1024;

const activityEntry = /\.(fit|gpx|tcx)(\.gz)?$/i;
const xmlRoot = /<(?:[\w.-]+:)?(gpx|TrainingCenterDatabase)[\s>/]/;

const isGzip = (bytes: Uint8Array): boolean => bytes[0] === 0x1f && bytes[1] === 0x8b;
const isZip = (bytes: Uint8Array): boolean => bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
const isFit = (bytes: Uint8Array): boolean => bytes.length >= 12 && bytes[8] === 0x2e && bytes[9] === 0x46 && bytes[10] === 0x49 && bytes[11] === 0x54;

function inflated<T>(inflate: () => T): T {
  try {
    return inflate();
  } catch (error) {
    if (error instanceof Error && "code" in error) throw new ImportError("malformed", `the compressed data is invalid: ${error.message}`);
    throw error;
  }
}

function gunzip(bytes: Uint8Array): Uint8Array {
  const content = inflated(() => gunzipSync(bytes));
  if (content.length > maxActivityFileBytes) throw new ImportError("invalid_value", "the activity file is too large");
  return content;
}

/** The one activity file of an archive such as Garmin Connect's "Export original". */
function zipEntry(bytes: Uint8Array): Uint8Array {
  const names: string[] = [];
  const entries = inflated(() =>
    unzipSync(bytes, {
      filter: (file) => {
        const wanted = activityEntry.test(file.name) && !file.name.startsWith("__MACOSX/");
        if (wanted) names.push(file.name);
        if (wanted && file.originalSize > maxActivityFileBytes) throw new ImportError("invalid_value", `${file.name} is too large`);
        return wanted && names.length === 1;
      },
    }),
  );
  if (names.length === 0) throw new ImportError("no_activity_data", "the archive holds no FIT, GPX or TCX file");
  if (names.length > 1) throw new ImportError("several_activities", `the archive holds ${names.length} activity files`);
  const entry = entries[names[0] ?? ""];
  if (entry === undefined) throw new ImportError("malformed", "the archive entry cannot be read");
  return entry;
}

/** Archive layers unpacked at most, as a gzip inside a ZIP entry. */
const maxLayers = 2;

function readContent(bytes: Uint8Array, layers: number): ImportedActivity {
  if (layers < maxLayers && isGzip(bytes)) return readContent(gunzip(bytes), maxLayers);
  if (layers < maxLayers && isZip(bytes)) return readContent(zipEntry(bytes), layers + 1);
  if (isFit(bytes)) return readFit(bytes);
  const head = String.fromCharCode(...bytes.subarray(0, 2048));
  switch (xmlRoot.exec(head)?.[1]) {
    case "gpx":
      return readGpx(bytes);
    case "TrainingCenterDatabase":
      return readTcx(bytes);
    default:
      throw new ImportError("unsupported_format", "the file is not a FIT, GPX or TCX activity");
  }
}

/**
 * Reads an activity file whatever its name: FIT, GPX or TCX, possibly gzip-compressed (`.fit.gz`, `IO-013`), or a ZIP holding
 * exactly one of them (Garmin Connect "Export original", `IO-050`). Throws `ImportError` and nothing else for a bad file.
 */
export function readActivityFile(bytes: Uint8Array): ImportedActivity {
  return readContent(bytes, 0);
}
