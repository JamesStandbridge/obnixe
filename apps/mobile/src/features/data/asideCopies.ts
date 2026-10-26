import { Directory, File, Paths } from "expo-file-system";
import { shareAsync } from "expo-sharing";
import type { EpochMs } from "@obnixe/schema";
import { asidePrefix } from "@/data/database";

export interface AsideCopy {
  readonly name: string;
  readonly setAsideAt: EpochMs;
  readonly bytes: number;
  readonly raw: boolean;
}

const companionSuffixes = ["-wal", "-shm"] as const;
const copyName = new RegExp(`^${asidePrefix}(\\d+)(-raw)?\\.db$`);

const sqliteDirectory = (): Directory => new Directory(Paths.document, "SQLite");

function filesOf(name: string): File[] {
  return [name, ...companionSuffixes.map((suffix) => `${name}${suffix}`)].map((file) => new File(sqliteDirectory(), file)).filter((file) => file.exists);
}

export function listAsideCopies(): AsideCopy[] {
  const directory = sqliteDirectory();
  if (!directory.exists) return [];
  return directory
    .list()
    .flatMap((entry): AsideCopy[] => {
      if (!(entry instanceof File)) return [];
      const match = copyName.exec(entry.name);
      if (match === null) return [];
      return [{ name: entry.name, setAsideAt: Number(match[1]) as EpochMs, bytes: filesOf(entry.name).reduce((sum, file) => sum + (file.size ?? 0), 0), raw: match[2] !== undefined }];
    })
    .sort((left, right) => right.setAsideAt - left.setAsideAt);
}

export async function shareAsideCopy(copy: AsideCopy): Promise<void> {
  await shareAsync(new File(sqliteDirectory(), copy.name).uri, { mimeType: "application/vnd.sqlite3", UTI: "public.database", dialogTitle: copy.name });
}

export function deleteAsideCopy(copy: AsideCopy): void {
  for (const file of filesOf(copy.name)) file.delete();
}
