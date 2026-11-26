import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { trackDigest, trackDirectory, trackFileExtension, trackFilePath } from "@obnixe/core";
import type { Id } from "@obnixe/schema";
import { availableBytes, deleteTrack, journalSessionIds, journalUri, readJournalFile, readTrack, storedTrackFiles, sweepTemporaryTracks, writeTrack } from "@/features/tracking/trackStore.web";

const recordingId = "0190a3f2-7c4e-7d21-9b1a-5f2e8c3d4a10" as Id;

class MemoryFile {
  constructor(readonly entries: Map<string, Uint8Array>, readonly name: string) {}

  readonly kind = "file";

  async getFile(): Promise<{ arrayBuffer: () => Promise<ArrayBuffer> }> {
    const bytes = this.entries.get(this.name) ?? new Uint8Array();
    return { arrayBuffer: async () => bytes.slice().buffer };
  }

  async createWritable(): Promise<{ write: (bytes: Uint8Array) => Promise<void>; close: () => Promise<void> }> {
    let written = new Uint8Array();
    return {
      write: async (bytes) => {
        written = new Uint8Array(bytes);
      },
      close: async () => {
        this.entries.set(this.name, written);
      },
    };
  }
}

class MemoryDirectory {
  readonly kind = "directory";
  readonly files = new Map<string, Uint8Array>();
  readonly folders = new Map<string, MemoryDirectory>();

  async getDirectoryHandle(name: string, options: { readonly create?: boolean } = {}): Promise<MemoryDirectory> {
    const existing = this.folders.get(name);
    if (existing !== undefined) return existing;
    if (options.create !== true) throw new DOMException(name, "NotFoundError");
    const created = new MemoryDirectory();
    this.folders.set(name, created);
    return created;
  }

  async getFileHandle(name: string, options: { readonly create?: boolean } = {}): Promise<MemoryFile> {
    if (!this.files.has(name)) {
      if (options.create !== true) throw new DOMException(name, "NotFoundError");
      this.files.set(name, new Uint8Array());
    }
    return new MemoryFile(this.files, name);
  }

  async removeEntry(name: string): Promise<void> {
    if (!this.files.delete(name)) throw new DOMException(name, "NotFoundError");
  }

  async *entries(): AsyncGenerator<[string, MemoryFile]> {
    for (const name of [...this.files.keys()]) yield [name, new MemoryFile(this.files, name)];
  }
}

let root: MemoryDirectory;

beforeEach(() => {
  root = new MemoryDirectory();
  vi.stubGlobal("navigator", { storage: { getDirectory: async () => root, estimate: async () => ({ quota: 5_000_000, usage: 1_000_000 }) } });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("web track store (PLT-021)", () => {
  it("keeps tracks in the origin private file system under the phone's paths", async () => {
    const bytes = new Uint8Array([79, 84, 82, 75, 1, 2, 3]);
    const stored = await writeTrack(recordingId, bytes);
    expect(stored).toEqual({ file: trackFilePath(recordingId), sha256: trackDigest(bytes), bytes: bytes.length });
    expect(await readTrack(stored.file)).toEqual(bytes);
    expect(await storedTrackFiles()).toEqual([stored.file]);
    await deleteTrack(stored.file);
    expect(await readTrack(stored.file)).toBeNull();
    expect(await availableBytes()).toBe(4_000_000);
  });

  it("sweeps temporary copies left by an interrupted write", async () => {
    const folder = await root.getDirectoryHandle(trackDirectory, { create: true });
    folder.files.set(`${recordingId}${trackFileExtension}.tmp`, new Uint8Array([1]));
    await sweepTemporaryTracks();
    expect([...folder.files.keys()]).toEqual([]);
  });

  it("has no raw journal, since the web never records", async () => {
    expect(() => journalUri(recordingId)).toThrow();
    expect(await readJournalFile(recordingId)).toBeNull();
    expect(await journalSessionIds()).toEqual([]);
  });
});
