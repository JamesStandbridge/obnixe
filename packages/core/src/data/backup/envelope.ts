import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { bytesToHex, hexToBytes } from "@noble/ciphers/utils.js";
import { scryptAsync } from "@noble/hashes/scrypt.js";
import { z } from "zod";
import { catalogVersion } from "@obnixe/schema";
import type { EpochMs, RandomFill } from "@obnixe/schema";
import { decodeUtf8, encodeUtf8, InvalidUtf8Error } from "../utf8.ts";
import { packSnapshot, unpackSnapshot } from "./container.ts";
import { backupSchemaVersion, CorruptedBackupError } from "./snapshot.ts";
import type { Snapshot } from "./snapshot.ts";

const magic = encodeUtf8("OBNIXE");
const formatVersion = 1;
const prefixLength = magic.length + 1 + 4;
const keyLength = 32;
const checkLength = 16;
const saltLength = 16;
const nonceLength = 24;

export const backupFileExtension = "obnixe";

export interface ScryptParams {
  readonly name: "scrypt";
  readonly logN: number;
  readonly r: number;
  readonly p: number;
}

export const defaultKdf: ScryptParams = { name: "scrypt", logN: 16, r: 8, p: 1 };

const kdfSchema = z.object({
  name: z.literal("scrypt"),
  logN: z.int().min(10).max(20),
  r: z.int().min(1).max(16),
  p: z.int().min(1).max(4),
});

const hex = (length: number) => z.string().regex(new RegExp(`^[0-9a-f]{${length * 2}}$`));

const headerSchema = z.object({
  createdAt: z.int(),
  schemaVersion: z.int().positive(),
  catalogVersion: z.int().positive(),
  includesPhotos: z.boolean(),
  kdf: kdfSchema,
  salt: hex(saltLength),
  nonce: hex(nonceLength),
  check: hex(checkLength),
});

/** Plaintext part of a backup file, authenticated as associated data of the ciphertext. */
export interface BackupHeader {
  readonly createdAt: EpochMs;
  readonly schemaVersion: number;
  readonly catalogVersion: number;
  readonly includesPhotos: boolean;
  readonly kdf: ScryptParams;
  readonly salt: string;
  readonly nonce: string;
  readonly check: string;
}

export interface SealedBackup {
  readonly header: BackupHeader;
  readonly bytes: Uint8Array;
}

interface OpenedEnvelope {
  readonly header: BackupHeader;
  readonly associatedData: Uint8Array;
  readonly ciphertext: Uint8Array;
}

export class NotABackupError extends Error {
  constructor() {
    super("The file is not an Obnixe backup");
  }
}

export class WrongPassphraseError extends Error {
  constructor() {
    super("The passphrase does not open this backup");
  }
}

export type NewerPart = "format" | "schema" | "catalog";

export class NewerBackupError extends Error {
  constructor(readonly part: NewerPart, readonly found: number, readonly supported: number) {
    super(`Backup ${part} version ${found} is newer than supported ${supported}`);
  }
}

export interface SealOptions {
  readonly passphrase: string;
  readonly fillRandom: RandomFill;
  readonly kdf?: ScryptParams;
  readonly onProgress?: (progress: number) => void;
}

export interface OpenOptions {
  readonly passphrase: string;
  readonly onProgress?: (progress: number) => void;
}

interface DerivedKey {
  readonly key: Uint8Array;
  readonly check: Uint8Array;
}

async function derive(passphrase: string, salt: Uint8Array, kdf: ScryptParams, onProgress: ((progress: number) => void) | undefined): Promise<DerivedKey> {
  const derived = await scryptAsync(encodeUtf8(passphrase.normalize("NFC")), salt, {
    N: 2 ** kdf.logN,
    r: kdf.r,
    p: kdf.p,
    dkLen: keyLength + checkLength,
    ...(onProgress === undefined ? {} : { onProgress }),
  });
  return { key: derived.slice(0, keyLength), check: derived.slice(keyLength) };
}

function randomBytes(fillRandom: RandomFill, length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  fillRandom(bytes);
  return bytes;
}

export async function sealSnapshot(snapshot: Snapshot, options: SealOptions): Promise<SealedBackup> {
  const kdf = options.kdf ?? defaultKdf;
  const salt = randomBytes(options.fillRandom, saltLength);
  const nonce = randomBytes(options.fillRandom, nonceLength);
  const { key, check } = await derive(options.passphrase, salt, kdf, options.onProgress);
  const header: BackupHeader = {
    createdAt: snapshot.createdAt,
    schemaVersion: snapshot.schemaVersion,
    catalogVersion: snapshot.catalogVersion,
    includesPhotos: snapshot.photos.length > 0,
    kdf,
    salt: bytesToHex(salt),
    nonce: bytesToHex(nonce),
    check: bytesToHex(check),
  };
  const headerBytes = encodeUtf8(JSON.stringify(header));
  const associatedData = new Uint8Array(prefixLength + headerBytes.length);
  associatedData.set(magic, 0);
  associatedData[magic.length] = formatVersion;
  new DataView(associatedData.buffer).setUint32(magic.length + 1, headerBytes.length);
  associatedData.set(headerBytes, prefixLength);
  const ciphertext = xchacha20poly1305(key, nonce, associatedData).encrypt(packSnapshot(snapshot));
  const bytes = new Uint8Array(associatedData.length + ciphertext.length);
  bytes.set(associatedData, 0);
  bytes.set(ciphertext, associatedData.length);
  return { header, bytes };
}

function envelope(bytes: Uint8Array): OpenedEnvelope {
  if (bytes.length < prefixLength || magic.some((byte, index) => bytes[index] !== byte)) throw new NotABackupError();
  const version = bytes[magic.length] ?? 0;
  if (version > formatVersion) throw new NewerBackupError("format", version, formatVersion);
  if (version < 1) throw new CorruptedBackupError(`unknown format ${version}`);
  const headerLength = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(magic.length + 1);
  const headerEnd = prefixLength + headerLength;
  if (headerEnd > bytes.length) throw new CorruptedBackupError("header truncated");
  const parsed = headerSchema.safeParse(parseHeader(bytes.subarray(prefixLength, headerEnd)));
  if (!parsed.success) throw new CorruptedBackupError(parsed.error.message);
  return { header: parsed.data as BackupHeader, associatedData: bytes.subarray(0, headerEnd), ciphertext: bytes.subarray(headerEnd) };
}

function parseHeader(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(decodeUtf8(bytes)) as unknown;
  } catch (error) {
    if (error instanceof InvalidUtf8Error || error instanceof SyntaxError) throw new CorruptedBackupError(error.message);
    throw error;
  }
}

export function assertSupportedVersions(schemaVersion: number, snapshotCatalogVersion: number): void {
  if (schemaVersion > backupSchemaVersion) throw new NewerBackupError("schema", schemaVersion, backupSchemaVersion);
  if (snapshotCatalogVersion > catalogVersion) throw new NewerBackupError("catalog", snapshotCatalogVersion, catalogVersion);
}

/** Reads the plaintext header without the passphrase; throws when the file cannot be imported by this app. */
export function readBackupHeader(bytes: Uint8Array): BackupHeader {
  const { header } = envelope(bytes);
  assertSupportedVersions(header.schemaVersion, header.catalogVersion);
  return header;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  return difference === 0;
}

function decrypt(key: Uint8Array, nonce: Uint8Array, associatedData: Uint8Array, ciphertext: Uint8Array): Uint8Array {
  try {
    return xchacha20poly1305(key, nonce, associatedData).decrypt(ciphertext);
  } catch (error) {
    if (error instanceof Error && (error.message === "invalid tag" || error.message.startsWith('"ciphertext" expected length'))) {
      throw new CorruptedBackupError("authentication failed");
    }
    throw error;
  }
}

export async function openSnapshot(bytes: Uint8Array, options: OpenOptions): Promise<Snapshot> {
  const { header, associatedData, ciphertext } = envelope(bytes);
  assertSupportedVersions(header.schemaVersion, header.catalogVersion);
  const { key, check } = await derive(options.passphrase, hexToBytes(header.salt), header.kdf, options.onProgress);
  if (!sameBytes(check, hexToBytes(header.check))) throw new WrongPassphraseError();
  const snapshot = unpackSnapshot(decrypt(key, hexToBytes(header.nonce), associatedData, ciphertext));
  if (snapshot.schemaVersion !== header.schemaVersion || snapshot.catalogVersion !== header.catalogVersion || snapshot.createdAt !== header.createdAt) {
    throw new CorruptedBackupError("header does not match content");
  }
  return snapshot;
}
