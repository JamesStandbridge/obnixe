import { zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { crc32 } from "../codec/crc32.ts";
import { ArchiveError, archiveChunkBytes, readZipDirectory, readZipEntry, storedEntrySource, streamZipEntry } from "./zipArchive.ts";
import type { ArchiveErrorReason, ArchiveSource, ZipEntry } from "./zipArchive.ts";

const encoder = new TextEncoder();

function memory(bytes: Uint8Array): ArchiveSource {
  return { size: bytes.length, read: async (offset, length) => bytes.slice(offset, offset + length) };
}

/** Text that compresses, long enough to stream over several chunks. */
function pseudoText(bytes: number): Uint8Array {
  const words = ["trail", "col", "foulée", "montée", "descente", "ravito", "km", "souffle"];
  let seed = 7;
  const parts: string[] = [];
  let length = 0;
  while (length < bytes) {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
    const word = `${words[seed % words.length] ?? ""} ${seed % 1000} `;
    parts.push(word);
    length += word.length;
  }
  return encoder.encode(parts.join("")).slice(0, bytes);
}

const signature = (bytes: Uint8Array, value: number, from = 0): number => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let at = from; at + 4 <= bytes.length; at += 1) if (view.getUint32(at, true) === value) return at;
  throw new Error(`signature ${value.toString(16)} not found`);
};
const centralAt = (bytes: Uint8Array): number => signature(bytes, 0x02014b50);

async function refusal(task: Promise<unknown>): Promise<ArchiveErrorReason> {
  try {
    await task;
  } catch (error) {
    if (error instanceof ArchiveError) return error.reason;
    throw error;
  }
  throw new Error("expected an ArchiveError");
}

function entryOf(entries: readonly ZipEntry[], path: string): ZipEntry {
  const entry = entries.find((candidate) => candidate.path === path);
  if (entry === undefined) throw new Error(`no entry ${path}`);
  return entry;
}

/** A one-entry stored archive whose sizes, offset and directory all go through ZIP64 records. */
function zip64Archive(name: string, content: Uint8Array): Uint8Array {
  const nameBytes = encoder.encode(name);
  const local = new Uint8Array(30 + nameBytes.length + content.length);
  const lv = new DataView(local.buffer);
  lv.setUint32(0, 0x04034b50, true);
  lv.setUint16(4, 45, true);
  lv.setUint32(14, crc32(content), true);
  lv.setUint32(18, content.length, true);
  lv.setUint32(22, content.length, true);
  lv.setUint16(26, nameBytes.length, true);
  local.set(nameBytes, 30);
  local.set(content, 30 + nameBytes.length);
  const central = new Uint8Array(46 + nameBytes.length + 28);
  const cv = new DataView(central.buffer);
  cv.setUint32(0, 0x02014b50, true);
  cv.setUint16(4, 45, true);
  cv.setUint16(6, 45, true);
  cv.setUint32(16, crc32(content), true);
  cv.setUint32(20, 0xffffffff, true);
  cv.setUint32(24, 0xffffffff, true);
  cv.setUint16(28, nameBytes.length, true);
  cv.setUint16(30, 28, true);
  cv.setUint32(42, 0xffffffff, true);
  central.set(nameBytes, 46);
  const extra = 46 + nameBytes.length;
  cv.setUint16(extra, 1, true);
  cv.setUint16(extra + 2, 24, true);
  cv.setBigUint64(extra + 4, BigInt(content.length), true);
  cv.setBigUint64(extra + 12, BigInt(content.length), true);
  cv.setBigUint64(extra + 20, 0n, true);
  const tail = new Uint8Array(56 + 20 + 22);
  const tv = new DataView(tail.buffer);
  tv.setUint32(0, 0x06064b50, true);
  tv.setBigUint64(4, 44n, true);
  tv.setBigUint64(24, 1n, true);
  tv.setBigUint64(32, 1n, true);
  tv.setBigUint64(40, BigInt(central.length), true);
  tv.setBigUint64(48, BigInt(local.length), true);
  tv.setUint32(56, 0x07064b50, true);
  tv.setBigUint64(64, BigInt(local.length + central.length), true);
  tv.setUint32(72, 1, true);
  tv.setUint32(76, 0x06054b50, true);
  tv.setUint16(84, 0xffff, true);
  tv.setUint16(86, 0xffff, true);
  tv.setUint32(88, 0xffffffff, true);
  tv.setUint32(92, 0xffffffff, true);
  const archive = new Uint8Array(local.length + central.length + tail.length);
  archive.set(local, 0);
  archive.set(central, local.length);
  archive.set(tail, local.length + central.length);
  return archive;
}

describe("readZipDirectory and readZipEntry (IO-021)", () => {
  const notes = pseudoText(40_000);
  const archive = zipSync({ "dir/": new Uint8Array(), "dir/notes.txt": notes, "dir/raw.bin": [encoder.encode("brut"), { level: 0 }], "é/ünïcode.txt": encoder.encode("ok") }, { comment: "Garmin export" });

  it("lists entries from the central directory, UTF-8 names and comment included, and reads them", async () => {
    const source = memory(archive);
    const entries = await readZipDirectory(source);
    expect(entries.map((entry) => entry.path)).toEqual(["dir/", "dir/notes.txt", "dir/raw.bin", "é/ünïcode.txt"]);
    expect(await readZipEntry(source, entryOf(entries, "dir/notes.txt"), notes.length)).toEqual(notes);
    expect(new TextDecoder().decode(await readZipEntry(source, entryOf(entries, "dir/raw.bin"), 10))).toBe("brut");
  });

  it("reads only the end, the directory and the entry asked for, never the whole archive", async () => {
    const padding = pseudoText(400_000);
    const large = zipSync({ "padding.bin": [padding, { level: 0 }], "activity.txt": encoder.encode("sortie") });
    const reads: number[] = [];
    const source: ArchiveSource = { size: large.length, read: async (offset, length) => (reads.push(length), large.slice(offset, offset + length)) };
    const entries = await readZipDirectory(source);
    expect(new TextDecoder().decode(await readZipEntry(source, entryOf(entries, "activity.txt"), 10))).toBe("sortie");
    expect(reads.reduce((sum, length) => sum + length, 0)).toBeLessThan(80_000);
  });

  it("reads ZIP64 sizes, offsets and directory records", async () => {
    const content = encoder.encode("activité ZIP64");
    const source = memory(zip64Archive("big/activity.txt", content));
    const [entry] = await readZipDirectory(source);
    expect(entry).toMatchObject({ path: "big/activity.txt", size: content.length, compressedSize: content.length, headerOffset: 0 });
    expect(await readZipEntry(source, entry as ZipEntry, 100)).toEqual(content);
  });

  it("refuses what is not a ZIP, is cut, encrypted, compressed otherwise, corrupted or too large", async () => {
    expect(await refusal(readZipDirectory(memory(encoder.encode("not a zip at all, just some text long enough"))))).toBe("not_a_zip");
    expect(await refusal(readZipDirectory(memory(archive.slice(0, archive.length - 30))))).toBe("not_a_zip");

    const entries = await readZipDirectory(memory(archive));
    const raw = entryOf(entries, "dir/raw.bin");
    expect(await refusal(readZipEntry(memory(archive), { ...raw, headerOffset: archive.length - 10 }, 10))).toBe("truncated");
    expect(await refusal(readZipEntry(memory(archive), { ...raw, flags: raw.flags | 1 }, 10))).toBe("encrypted");
    expect(await refusal(readZipEntry(memory(archive), { ...raw, method: 12 }, 10))).toBe("unsupported_compression");
    expect(await refusal(readZipEntry(memory(archive), raw, 3))).toBe("too_large");

    const corrupted = archive.slice();
    const dataStart = signature(corrupted, 0x04034b50, raw.headerOffset) + 30 + "dir/raw.bin".length;
    corrupted[dataStart] = (corrupted[dataStart] ?? 0) ^ 0xff;
    expect(await refusal(readZipEntry(memory(corrupted), raw, 10))).toBe("checksum");

    const notesEntry = entryOf(entries, "dir/notes.txt");
    expect(await refusal(readZipEntry(memory(archive), { ...notesEntry, size: 100 }, notes.length))).toBe("checksum");

    const broken = archive.slice();
    broken[centralAt(broken)] = 0;
    expect(await refusal(readZipDirectory(memory(broken)))).toBe("malformed");
  });
});

describe("streamZipEntry and storedEntrySource", () => {
  const content = pseudoText(3 * archiveChunkBytes + 12_345);

  it("inflates a large entry chunk by chunk, checks its CRC and paces between chunks", async () => {
    const archive = zipSync({ "inner.zip": content });
    const source = memory(archive);
    const [entry] = await readZipDirectory(source);
    if (entry === undefined) throw new Error("no entry");
    const parts: Uint8Array[] = [];
    const progress: number[] = [];
    let paced = 0;
    await streamZipEntry(
      source,
      entry,
      async (chunk, compressedRead) => {
        parts.push(chunk);
        progress.push(compressedRead);
      },
      async () => {
        paced += 1;
      },
    );
    const joined = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
    parts.reduce((offset, part) => (joined.set(part, offset), offset + part.length), 0);
    expect(joined.length).toBe(content.length);
    expect(crc32(joined)).toBe(crc32(content));
    expect(progress.at(-1)).toBe(entry.compressedSize);
    expect([...progress].sort((left, right) => left - right)).toEqual(progress);
    expect(paced).toBe(Math.ceil(entry.compressedSize / archiveChunkBytes));
    expect(await refusal(streamZipEntry(source, { ...entry, crc: entry.crc ^ 1 }, async () => undefined, async () => undefined))).toBe("checksum");
  });

  it("streams several chunks of a stored entry, and reads a stored entry in place", async () => {
    const archive = zipSync({ "inner.bin": [content, { level: 0 }] });
    const source = memory(archive);
    const [entry] = await readZipDirectory(source);
    if (entry === undefined) throw new Error("no entry");
    let size = 0;
    await streamZipEntry(source, entry, async (chunk) => void (size += chunk.length), async () => undefined);
    expect(size).toBe(content.length);
    const inPlace = await storedEntrySource(source, entry);
    expect(inPlace?.size).toBe(content.length);
    expect(await inPlace?.read(content.length - 4, 100)).toEqual(content.slice(-4));
    const deflated = zipSync({ "inner.bin": content });
    const [compressed] = await readZipDirectory(memory(deflated));
    expect(await storedEntrySource(memory(deflated), compressed as ZipEntry)).toBeNull();
  });
});
