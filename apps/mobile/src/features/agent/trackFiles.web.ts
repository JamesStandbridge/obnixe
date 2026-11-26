/** The web build keeps tracks in OPFS, which has no synchronous read, so agent tool calls cannot open them. */
export function readTrackFile(_file: string): Uint8Array | null {
  return null;
}
