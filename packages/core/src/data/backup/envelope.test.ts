import { randomFillSync } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { catalogVersion } from "@obnixe/schema";
import type { EpochMs, Id } from "@obnixe/schema";
import { createTestContext } from "../../testing.ts";
import type { TestContext } from "../../testing.ts";
import { fixtures } from "../testFixtures.ts";
import { decodeUtf8, encodeUtf8 } from "../utf8.ts";
import { packSnapshot, unpackSnapshot } from "./container.ts";
import { NewerBackupError, NotABackupError, WrongPassphraseError, defaultKdf, openSnapshot, readBackupHeader, sealSnapshot } from "./envelope.ts";
import type { ScryptParams } from "./envelope.ts";
import { CorruptedBackupError, InvalidSnapshotError, backupSchemaVersion, buildSnapshot } from "./snapshot.ts";
import type { Snapshot } from "./snapshot.ts";

const fastKdf: ScryptParams = { name: "scrypt", logN: 10, r: 8, p: 1 };
const fillRandom = (bytes: Uint8Array): void => {
  randomFillSync(bytes);
};

let context: TestContext;
let snapshot: Snapshot;

beforeEach(() => {
  context = createTestContext();
  const make = fixtures(context);
  const bench = make.exercise("Développé couché");
  const workout = make.session();
  const entry = make.entry(workout.id, bench.id, 0);
  make.write([
    { kind: "insert", table: "exercise", row: bench },
    { kind: "insert", table: "session", row: workout },
    { kind: "insert", table: "strength_entry", row: entry },
    { kind: "insert", table: "strength_set", row: make.set(entry.id, 0, 8) },
    { kind: "insert", table: "weigh_in", row: make.weighIn("2026-10-24", 72400) },
  ]);
  snapshot = buildSnapshot(context.db, context.env.now(), [{ photoId: "photo-1" as Id, bytes: Uint8Array.from([1, 2, 3, 250]) }]);
});

async function seal(source: Snapshot = snapshot, passphrase = "corde rouge 42"): Promise<Uint8Array> {
  return (await sealSnapshot(source, { passphrase, fillRandom, kdf: fastKdf })).bytes;
}

describe("utf8", () => {
  it("round trips accents and astral characters", () => {
    const text = "Développé couché, Épaule — 𝄞 ok";
    expect(decodeUtf8(encodeUtf8(text))).toBe(text);
    expect(encodeUtf8(text)).toEqual(new TextEncoder().encode(text));
  });
});

describe("container", () => {
  it("packs rows, settings and photo bytes", () => {
    const unpacked = unpackSnapshot(packSnapshot(snapshot));
    expect(unpacked.tables).toEqual(snapshot.tables);
    expect(unpacked.settings).toEqual(snapshot.settings);
    expect(unpacked.photos).toEqual(snapshot.photos);
  });

  it("rejects rows the schema does not accept", () => {
    const broken: Snapshot = { ...snapshot, tables: { ...snapshot.tables, session: snapshot.tables.session.map((row) => ({ ...row, status: "paused" as never })) } };
    expect(() => unpackSnapshot(packSnapshot(broken))).toThrow(InvalidSnapshotError);
  });

  it("rejects session values the catalog does not accept", () => {
    const broken: Snapshot = { ...snapshot, tables: { ...snapshot.tables, session: snapshot.tables.session.map((row) => ({ ...row, values: { distance: 5000 } })) } };
    expect(() => unpackSnapshot(packSnapshot(broken))).toThrow(InvalidSnapshotError);
  });
});

describe("envelope", () => {
  it("round trips with the passphrase", async () => {
    const opened = await openSnapshot(await seal(), { passphrase: "corde rouge 42" });
    expect(opened.tables).toEqual(snapshot.tables);
    expect(opened.photos).toEqual(snapshot.photos);
    expect(opened.schemaVersion).toBe(backupSchemaVersion);
    expect(opened.catalogVersion).toBe(catalogVersion);
  });

  it("uses the default scrypt parameters", async () => {
    const sealed = await sealSnapshot(snapshot, { passphrase: "secret phrase", fillRandom });
    expect(sealed.header.kdf).toEqual(defaultKdf);
    expect(readBackupHeader(sealed.bytes)).toEqual(sealed.header);
    await expect(openSnapshot(sealed.bytes, { passphrase: "secret phrase" })).resolves.toMatchObject({ createdAt: snapshot.createdAt });
  });

  it("exposes the plaintext header without the passphrase", async () => {
    const header = readBackupHeader(await seal());
    expect(header).toMatchObject({ createdAt: snapshot.createdAt, schemaVersion: backupSchemaVersion, catalogVersion, includesPhotos: true, kdf: fastKdf });
  });

  it("never reuses salt or nonce", async () => {
    const first = readBackupHeader(await seal());
    const second = readBackupHeader(await seal());
    expect(first.salt).not.toBe(second.salt);
    expect(first.nonce).not.toBe(second.nonce);
  });

  it("normalizes the passphrase", async () => {
    const bytes = await seal(snapshot, "caf\u00e9 du matin");
    await expect(openSnapshot(bytes, { passphrase: "cafe\u0301 du matin" })).resolves.toMatchObject({ createdAt: snapshot.createdAt });
  });

  it("tells a wrong passphrase apart", async () => {
    await expect(openSnapshot(await seal(), { passphrase: "corde rouge 43" })).rejects.toThrow(WrongPassphraseError);
  });

  it("detects tampered ciphertext", async () => {
    const bytes = await seal();
    bytes[bytes.length - 20] = (bytes[bytes.length - 20] ?? 0) ^ 0x01;
    await expect(openSnapshot(bytes, { passphrase: "corde rouge 42" })).rejects.toThrow(CorruptedBackupError);
  });

  it("detects a tampered header", async () => {
    const bytes = await seal();
    const stamp = `"createdAt":${snapshot.createdAt}`;
    const index = Buffer.from(bytes).indexOf(stamp);
    expect(index).toBeGreaterThan(0);
    const last = index + stamp.length - 1;
    bytes[last] = (bytes[last] ?? 0x30) === 0x39 ? 0x38 : (bytes[last] ?? 0x30) + 1;
    expect(readBackupHeader(bytes).createdAt).not.toBe(snapshot.createdAt);
    await expect(openSnapshot(bytes, { passphrase: "corde rouge 42" })).rejects.toThrow(CorruptedBackupError);
  });

  it("detects truncation", async () => {
    const bytes = await seal();
    await expect(openSnapshot(bytes.slice(0, bytes.length - 40), { passphrase: "corde rouge 42" })).rejects.toThrow(CorruptedBackupError);
    expect(() => readBackupHeader(bytes.slice(0, 30))).toThrow(CorruptedBackupError);
  });

  it("refuses files that are not backups", () => {
    expect(() => readBackupHeader(encodeUtf8('{"sessions": []}'))).toThrow(NotABackupError);
    expect(() => readBackupHeader(new Uint8Array(2))).toThrow(NotABackupError);
  });

  it("refuses backups from a newer schema or catalog", async () => {
    const newerSchema = await seal({ ...snapshot, schemaVersion: backupSchemaVersion + 1 });
    expect(() => readBackupHeader(newerSchema)).toThrow(NewerBackupError);
    await expect(openSnapshot(newerSchema, { passphrase: "corde rouge 42" })).rejects.toMatchObject({ part: "schema" });
    const newerCatalog = await seal({ ...snapshot, catalogVersion: catalogVersion + 1 });
    expect(() => readBackupHeader(newerCatalog)).toThrow(expect.objectContaining({ part: "catalog" }) as Error);
  });

  it("refuses a newer envelope format", async () => {
    const bytes = await seal();
    bytes[6] = 2;
    expect(() => readBackupHeader(bytes)).toThrow(expect.objectContaining({ part: "format" }) as Error);
  });

  it("records the snapshot instant", async () => {
    const at = 1_800_000_000_000 as EpochMs;
    expect(readBackupHeader(await seal({ ...snapshot, createdAt: at })).createdAt).toBe(at);
  });
});
