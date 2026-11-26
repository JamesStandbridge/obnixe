import { Directory, File, Paths } from "expo-file-system";

/** Small JSON documents of this device only, outside the journal and the backups. */
const stateDirectory = (): Directory => new Directory(Paths.document, "state");

export async function writeLocalState(name: string, text: string): Promise<void> {
  const directory = stateDirectory();
  directory.create({ idempotent: true, intermediates: true });
  const file = new File(directory, name);
  if (file.exists) file.delete();
  file.create();
  await file.write(text);
}

export async function readLocalState(name: string): Promise<string | null> {
  const file = new File(stateDirectory(), name);
  return file.exists ? new TextDecoder().decode(await file.bytes()) : null;
}

export function deleteLocalState(name: string): void {
  const file = new File(stateDirectory(), name);
  if (file.exists) file.delete();
}
