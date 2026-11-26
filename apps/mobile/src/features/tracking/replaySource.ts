import { getDocumentAsync } from "expo-document-picker";
import { Directory, File, Paths } from "expo-file-system";
import type { TrackerReplay } from "../../../modules/obnixe-tracker";

/** `TST-030`: in real time a replay survives a restart of the process, so the durability runs of the field protocol use it. */
export const replaySpeeds = [1, 10] as const;
export type ReplaySpeed = (typeof replaySpeeds)[number];

export interface ReplayChoice {
  readonly name: string;
  readonly replay: TrackerReplay;
}

/**
 * Development builds only: a GPX picked on the phone, copied into the documents so that a tracker restarted by the system
 * reads it again, replayed as simulated fixes instead of the location provider.
 */
export async function pickReplay(speed: ReplaySpeed): Promise<ReplayChoice | null> {
  const result = await getDocumentAsync({ type: "*/*", copyToCacheDirectory: true, multiple: false });
  if (result.canceled) return null;
  const [asset] = result.assets;
  if (asset === undefined) return null;
  const directory = new Directory(Paths.document, "replays");
  directory.create({ idempotent: true, intermediates: true });
  const target = new File(directory, "replay.gpx");
  await new File(asset.uri).move(target, { overwrite: true });
  return { name: asset.name, replay: { gpxPath: target.uri, speed } };
}
