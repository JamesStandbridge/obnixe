import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { utf8ToBytes } from "@noble/hashes/utils.js";
import { z } from "zod";
import { Base64Error, fromBase64Url, toBase64Url } from "../encoding.ts";

/** Domain whose subdomains the Cloudflare relay serves: one per phone, plus the relay host phones connect to. */
export const remoteDomain = "obnixe.app";
export const remoteRelayHost = `relay.${remoteDomain}`;
export const remoteSeedBytes = 32;
export const remotePublicKeyBytes = 32;
export const remoteNonceBytes = 32;
export const remoteSignatureBytes = 64;
/** Largest request body the relay forwards, well under the WebSocket message limit once JSON-escaped. */
export const remoteBodyLimit = 512 * 1024;
export const remoteAnswerTimeoutMs = 30_000;
/** Lowercase RFC 4648 base32 of 128 bits: a valid DNS label. */
export const remotePhoneIdPattern = /^[a-z2-7]{26}$/;

const base32Alphabet = "abcdefghijklmnopqrstuvwxyz234567";
const phoneIdBytes = 16;

export interface RemoteIdentity {
  readonly seed: Uint8Array;
  readonly publicKey: Uint8Array;
  readonly id: string;
}

function base32(bytes: Uint8Array): string {
  let output = "";
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += base32Alphabet.charAt((buffer >> (bits - 5)) & 31);
      bits -= 5;
    }
    buffer &= (1 << bits) - 1;
  }
  return bits > 0 ? output + base32Alphabet.charAt((buffer << (5 - bits)) & 31) : output;
}

export function remotePhoneId(publicKey: Uint8Array): string {
  return base32(sha256(publicKey).slice(0, phoneIdBytes));
}

export function remoteIdentity(seed: Uint8Array): RemoteIdentity {
  if (seed.length !== remoteSeedBytes) throw new RangeError(`A remote identity seed holds ${remoteSeedBytes} bytes`);
  const publicKey = ed25519.getPublicKey(seed);
  return { seed, publicKey, id: remotePhoneId(publicKey) };
}

/** Public origin agents reach the phone at, without a trailing slash. */
export function remotePhoneOrigin(id: string): string {
  return `https://${id}.${remoteDomain}`;
}

export function remoteConnectUrl(publicKey: Uint8Array): string {
  return `wss://${remoteRelayHost}/connect?key=${toBase64Url(publicKey)}`;
}

function decodeExact(text: string, length: number): Uint8Array | null {
  try {
    const bytes = fromBase64Url(text);
    return bytes.length === length ? bytes : null;
  } catch (error) {
    if (error instanceof Base64Error) return null;
    throw error;
  }
}

/** Decodes the `key` a phone connects with; null unless it is a well-formed Ed25519 public key encoding. */
export function parseRemotePublicKey(text: string): Uint8Array | null {
  return decodeExact(text, remotePublicKeyBytes);
}

export function parseRemoteSignature(text: string): Uint8Array | null {
  return decodeExact(text, remoteSignatureBytes);
}

export function encodeRemoteNonce(bytes: Uint8Array): string {
  return toBase64Url(bytes);
}

/** What the phone signs to prove it holds the key behind its id; bound to the id so a proof cannot serve another phone. */
export function remoteChallengeMessage(id: string, nonce: string): Uint8Array {
  return utf8ToBytes(`obnixe-remote-relay/1\n${id}\n${nonce}`);
}

export function signRemoteChallenge(identity: RemoteIdentity, nonce: string): string {
  return toBase64Url(ed25519.sign(remoteChallengeMessage(identity.id, nonce), identity.seed));
}

const headersSchema = z.record(z.string(), z.string());

export const relayFrameSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("challenge"), nonce: z.string() }),
  z.object({ type: z.literal("online") }),
  z.object({ type: z.literal("request"), id: z.number().int().nonnegative(), method: z.string(), target: z.string(), headers: headersSchema, body: z.string() }),
]);

export const phoneFrameSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("proof"), signature: z.string() }),
  z.object({ type: z.literal("response"), id: z.number().int().nonnegative(), status: z.number().int().min(100).max(599), headers: headersSchema, body: z.string() }),
]);

/** Frames the relay sends the phone. */
export type RelayFrame = z.infer<typeof relayFrameSchema>;
/** Frames the phone sends the relay. */
export type PhoneFrame = z.infer<typeof phoneFrameSchema>;

function parseFrame<T>(schema: z.ZodType<T>, text: string): T | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function parseRelayFrame(text: string): RelayFrame | null {
  return parseFrame(relayFrameSchema, text);
}

export function parsePhoneFrame(text: string): PhoneFrame | null {
  return parseFrame(phoneFrameSchema, text);
}
