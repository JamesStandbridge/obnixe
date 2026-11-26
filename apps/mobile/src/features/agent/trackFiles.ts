import { File, Paths } from "expo-file-system";

/** Bytes of a stored `.otrk` track from its `recording.track_file` path under the document directory, `null` when it is gone. */
export function readTrackFile(file: string): Uint8Array | null {
  const track = new File(Paths.document, file);
  return track.exists ? track.bytesSync() : null;
}
