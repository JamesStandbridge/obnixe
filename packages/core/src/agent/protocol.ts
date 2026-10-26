import { chacha20poly1305 } from "@noble/ciphers/chacha.js";
import { x25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { hmac } from "@noble/hashes/hmac.js";
import { scryptAsync } from "@noble/hashes/scrypt.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { concatBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { z } from "zod";
import { connectionEndReasons } from "@obnixe/schema";
import { Base64Error, Utf8Error, fromBase64, fromUtf8, toBase64 } from "./encoding.ts";
import { phoneHostsSchema } from "./hosts.ts";

export const protocolVersion = 3;
export const defaultPhonePort = 7429;
export const defaultControlPort = 7430;
export const pairingCodeTtlMs = 5 * 60_000;
export const maxPairingAttempts = 5;
export const heartbeatIntervalMs = 15_000;
export const heartbeatTimeoutMs = 45_000;
export const nonceBytes = 32;
export const publicKeyBytes = 32;
export const proofBytes = 32;
export const openingBytes = 32;
export const identityBytes = 16;
export const pairingSecretBytes = 32;

const scryptCost = { N: 2 ** 14, r: 8, p: 1, dkLen: 32 } as const;
const sealedAad = utf8ToBytes("obnixe-sealed-v1");

export class ProtocolError extends Error {}

const base64 = z.string().regex(/^[A-Za-z0-9+/]*={0,2}$/);

export const rejectionReasons = ["code", "expired", "replaced", "version", "unknown", "revoked"] as const;
export type RejectionReason = (typeof rejectionReasons)[number];

const device = z.string().min(1).max(64);

export const pairingSecretKinds = ["code", "token"] as const;
export type PairingSecretKind = (typeof pairingSecretKinds)[number];

const frameSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("challenge"), version: z.int(), bridge: base64, nonce: base64, key: base64 }),
  z.object({ type: z.literal("hello"), version: z.int(), secret: z.enum(pairingSecretKinds), device, deviceId: base64, nonce: base64, key: base64 }),
  z.object({ type: z.literal("commit"), commitment: base64 }),
  z.object({ type: z.literal("proof"), proof: base64 }),
  z.object({ type: z.literal("welcome"), opening: base64, proof: base64 }),
  z.object({ type: z.literal("resume"), version: z.int(), device, deviceId: base64, pairing: base64, nonce: base64, key: base64, proof: base64 }),
  z.object({ type: z.literal("resumed"), proof: base64 }),
  z.object({ type: z.literal("revoke"), pairing: base64, proof: base64 }),
  z.object({ type: z.literal("rejected"), reason: z.enum(rejectionReasons) }),
  z.object({ type: z.literal("sealed"), seq: z.int().nonnegative(), box: base64 }),
]);

/**
 * Plaintext frames exchanged on the phone WebSocket.
 *
 * 1. bridge -> phone `challenge` with its persistent bridge id, a random nonce and an ephemeral X25519 public key.
 * 2. Pairing: phone -> bridge `hello` with the kind of shared secret it holds, its persistent device id, its own nonce and
 *    ephemeral X25519 public key. The secret is either a 6-digit code shown by the phone and typed on the Mac, or the
 *    one-time token of the QR code shown by the bridge. Both sides derive, per pairing attempt, HKDF(ECDH secret || secret
 *    key, transcript hash) into two proof keys, two session keys and the long-term pairing secret; the secret key is
 *    scrypt(code, transcript hash) for a code and HMAC(token, transcript hash) for a token, which needs no stretching.
 * 3. When `obnixe-bridge pair` posts the code typed by the user, or as soon as a token hello arrives while the bridge
 *    holds a live token, the bridge sends `commit`: a hash of a random opening and
 *    of its own proof. The phone answers `proof`, an HMAC over the transcript and the commitment. Only a matching proof
 *    earns `welcome`, which reveals the opening and the bridge proof. The commitment is sent before the bridge sees the
 *    phone proof, so a fake bridge that cracks the code offline afterwards cannot open it; a fake phone must answer before
 *    the reveal, so it gets one online guess per attempt. The raw code never travels. Both sides then keep the pairing
 *    secret, bound by the transcript to the bridge id and the device id, under a pairing id derived from the transcript.
 * 4. Trusted resume: a phone holding a pairing for the challenging bridge id answers `resume` instead of `hello`, with
 *    fresh ephemeral material and an HMAC proof keyed by HKDF(pairing secret || ECDH secret, resume transcript hash).
 *    The bridge answers `resumed` with its own proof only when the phone proof matches, or `rejected` with `unknown` or
 *    `revoked`. The pairing secret is uniformly random, so no recorded frame helps an offline guess, and the fresh
 *    ephemeral keys keep past sessions sealed if the secret later leaks.
 * 5. A phone that forgot a bridge sends `revoke` with a token derived from the deleted secret on its next challenge from
 *    that bridge, before its `hello`, so the bridge drops the pairing too.
 * 6. Every later message is a `sealed` JSON-RPC payload with a strictly increasing per-direction sequence number. The
 *    bridge lists the addresses it listens on in `session.open` and again in `session.hosts` when they change, so the
 *    phone can find it later without the user typing an address.
 */
export type Frame = z.infer<typeof frameSchema>;
export type SealedFrame = Extract<Frame, { type: "sealed" }>;

export function encodeFrame(frame: Frame): string {
  return JSON.stringify(frame);
}

export function decodeFrame(text: string): Frame {
  const parsed = frameSchema.safeParse(parseJson(text));
  if (!parsed.success) throw new ProtocolError(`Malformed frame: ${parsed.error.message}`);
  return parsed.data;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    if (error instanceof SyntaxError) throw new ProtocolError(`Frame is not JSON: ${error.message}`);
    throw error;
  }
}

function decodeUtf8(bytes: Uint8Array): string {
  try {
    return fromUtf8(bytes);
  } catch (error) {
    if (error instanceof Utf8Error) throw new ProtocolError(error.message);
    throw error;
  }
}

export function decodeBytes(text: string, length?: number): Uint8Array {
  let bytes: Uint8Array;
  try {
    bytes = fromBase64(text);
  } catch (error) {
    if (error instanceof Base64Error) throw new ProtocolError(error.message);
    throw error;
  }
  if (length !== undefined && bytes.length !== length) throw new ProtocolError(`Expected ${length} bytes, got ${bytes.length}`);
  return bytes;
}

const jsonRpc = z.literal("2.0");
const toolOutcomeSchema = z.object({ text: z.string(), isError: z.boolean() });

export type ToolOutcome = z.infer<typeof toolOutcomeSchema>;

const sessionOpenResultSchema = z.object({ connectionId: z.string() });
export type SessionOpenResult = z.infer<typeof sessionOpenResultSchema>;

const bridgeMessageSchema = z.discriminatedUnion("method", [
  z.object({ jsonrpc: jsonRpc, id: z.int(), method: z.literal("session.open"), params: z.object({ client: z.string(), host: z.string(), hosts: phoneHostsSchema }) }),
  z.object({ jsonrpc: jsonRpc, id: z.int(), method: z.literal("tools/call"), params: z.object({ name: z.string(), arguments: z.record(z.string(), z.unknown()) }) }),
  z.object({ jsonrpc: jsonRpc, method: z.literal("session.client"), params: z.object({ client: z.string() }) }),
  z.object({ jsonrpc: jsonRpc, method: z.literal("session.hosts"), params: z.object({ hosts: phoneHostsSchema }) }),
  z.object({ jsonrpc: jsonRpc, method: z.literal("ping") }),
]);

/** Sealed messages sent by the bridge: requests the phone must answer and notifications. */
export type BridgeMessage = z.infer<typeof bridgeMessageSchema>;

const phoneMessageSchema = z.union([
  z.object({ jsonrpc: jsonRpc, id: z.int(), result: z.unknown() }),
  z.object({ jsonrpc: jsonRpc, id: z.int(), error: z.object({ code: z.int(), message: z.string() }) }),
  z.object({ jsonrpc: jsonRpc, method: z.literal("session.close"), params: z.object({ reason: z.enum(connectionEndReasons) }) }),
]);

/** Sealed messages sent by the phone: responses to bridge requests and the closing notice. */
export type PhoneMessage = z.infer<typeof phoneMessageSchema>;

export const rpcErrorCodes = { methodNotFound: -32601, internal: -32603, notOpen: -32000 } as const;

export function parseBridgeMessage(value: unknown): BridgeMessage {
  const parsed = bridgeMessageSchema.safeParse(value);
  if (!parsed.success) throw new ProtocolError(`Unexpected bridge message: ${parsed.error.message}`);
  return parsed.data;
}

export function parsePhoneMessage(value: unknown): PhoneMessage {
  const parsed = phoneMessageSchema.safeParse(value);
  if (!parsed.success) throw new ProtocolError(`Unexpected phone message: ${parsed.error.message}`);
  return parsed.data;
}

export function parseToolOutcome(value: unknown): ToolOutcome {
  const parsed = toolOutcomeSchema.safeParse(value);
  if (!parsed.success) throw new ProtocolError(`Unexpected tool outcome: ${parsed.error.message}`);
  return parsed.data;
}

export function parseSessionOpenResult(value: unknown): SessionOpenResult {
  const parsed = sessionOpenResultSchema.safeParse(value);
  if (!parsed.success) throw new ProtocolError(`Unexpected session.open result: ${parsed.error.message}`);
  return parsed.data;
}

export type RandomBytes = (length: number) => Uint8Array;

const codeSpace = 1_000_000;
const codeLimit = Math.floor(0x1_0000_0000 / codeSpace) * codeSpace;

export function generatePairingCode(randomBytes: RandomBytes): string {
  for (;;) {
    const bytes = randomBytes(4);
    const value = (((bytes[0] ?? 0) << 24) | ((bytes[1] ?? 0) << 16) | ((bytes[2] ?? 0) << 8) | (bytes[3] ?? 0)) >>> 0;
    if (value < codeLimit) return String(value % codeSpace).padStart(6, "0");
  }
}

export function isPairingCode(text: string): boolean {
  return /^\d{6}$/.test(text);
}

export function generateIdentity(randomBytes: RandomBytes): string {
  return toBase64(randomBytes(identityBytes));
}

export interface EphemeralKeyPair {
  readonly secretKey: Uint8Array;
  readonly publicKey: Uint8Array;
}

export function generateEphemeralKeyPair(randomBytes: RandomBytes): EphemeralKeyPair {
  const secretKey = randomBytes(32);
  return { secretKey, publicKey: x25519.getPublicKey(secretKey) };
}

export function sharedSecret(secretKey: Uint8Array, peerPublicKey: Uint8Array): Uint8Array {
  try {
    return x25519.getSharedSecret(secretKey, peerPublicKey);
  } catch (error) {
    if (error instanceof Error && error.message === "invalid private or public key received") throw new ProtocolError("The peer sent an invalid public key");
    throw error;
  }
}

export interface PairingTranscript {
  readonly bridgeId: Uint8Array;
  readonly bridgeNonce: Uint8Array;
  readonly bridgeKey: Uint8Array;
  readonly deviceId: Uint8Array;
  readonly phoneNonce: Uint8Array;
  readonly phoneKey: Uint8Array;
  readonly device: string;
}

export interface ResumeTranscript extends PairingTranscript {
  readonly pairingId: Uint8Array;
}

function transcriptBytes(transcript: PairingTranscript): Uint8Array {
  return concatBytes(transcript.bridgeId, transcript.bridgeNonce, transcript.bridgeKey, transcript.deviceId, transcript.phoneNonce, transcript.phoneKey, utf8ToBytes(transcript.device));
}

export function transcriptHash(transcript: PairingTranscript): Uint8Array {
  return sha256(concatBytes(utf8ToBytes(`obnixe-pair-v${protocolVersion}`), transcriptBytes(transcript)));
}

export function resumeTranscriptHash(transcript: ResumeTranscript): Uint8Array {
  return sha256(concatBytes(utf8ToBytes(`obnixe-resume-v${protocolVersion}`), transcript.pairingId, transcriptBytes(transcript)));
}

export interface SessionKeys {
  readonly toPhone: Uint8Array;
  readonly toBridge: Uint8Array;
}

/** Proof and session keys of one handshake, bound to its transcript hash. */
export interface HandshakeSecrets {
  readonly transcriptHash: Uint8Array;
  readonly phoneProofKey: Uint8Array;
  readonly bridgeProofKey: Uint8Array;
  readonly sessionKeys: SessionKeys;
}

export interface PairingSecrets extends HandshakeSecrets {
  readonly pairingId: Uint8Array;
  readonly pairingSecret: Uint8Array;
}

function splitHandshake(hash: Uint8Array, material: Uint8Array): HandshakeSecrets {
  return {
    transcriptHash: hash,
    phoneProofKey: material.slice(0, 32),
    bridgeProofKey: material.slice(32, 64),
    sessionKeys: { toPhone: material.slice(64, 96), toBridge: material.slice(96, 128) },
  };
}

/** What both sides know before pairing: the code typed on the Mac, or the token carried by the QR code. */
export type PairingSecret = { readonly kind: "code"; readonly code: string } | { readonly kind: "token"; readonly token: Uint8Array };

function pairingSecretKey(secret: PairingSecret, hash: Uint8Array): Promise<Uint8Array> {
  switch (secret.kind) {
    case "code":
      return scryptAsync(utf8ToBytes(secret.code), concatBytes(utf8ToBytes("obnixe-pair"), hash), scryptCost);
    case "token":
      return Promise.resolve(hmac(sha256, secret.token, concatBytes(utf8ToBytes("obnixe-token"), hash)));
    default: {
      const unreachable: never = secret;
      throw new Error(`Unhandled pairing secret ${JSON.stringify(unreachable)}`);
    }
  }
}

/** Derives the proof, session and pairing keys of one pairing attempt; `shared` is the X25519 secret between the two ephemeral keys. */
export async function derivePairingSecrets(secret: PairingSecret, transcript: PairingTranscript, shared: Uint8Array): Promise<PairingSecrets> {
  const hash = transcriptHash(transcript);
  const secretKey = await pairingSecretKey(secret, hash);
  const material = hkdf(sha256, concatBytes(shared, secretKey), hash, utf8ToBytes(`obnixe-session-${secret.kind}`), 128 + pairingSecretBytes);
  return {
    ...splitHandshake(hash, material),
    pairingId: sha256(concatBytes(utf8ToBytes("obnixe-pairing-id"), hash)).slice(0, identityBytes),
    pairingSecret: material.slice(128, 128 + pairingSecretBytes),
  };
}

/** Derives the proof and session keys of a trusted resume from the stored pairing secret and fresh ephemeral keys. */
export function deriveResumeSecrets(pairingSecret: Uint8Array, transcript: ResumeTranscript, shared: Uint8Array): HandshakeSecrets {
  const hash = resumeTranscriptHash(transcript);
  return splitHandshake(hash, hkdf(sha256, concatBytes(pairingSecret, shared), hash, utf8ToBytes("obnixe-resume"), 128));
}

export function bridgeProof(secrets: HandshakeSecrets): Uint8Array {
  return hmac(sha256, secrets.bridgeProofKey, concatBytes(utf8ToBytes("welcome"), secrets.transcriptHash));
}

export function phoneProof(secrets: HandshakeSecrets, commitment: Uint8Array): Uint8Array {
  return hmac(sha256, secrets.phoneProofKey, concatBytes(utf8ToBytes("hello"), secrets.transcriptHash, commitment));
}

export function resumePhoneProof(secrets: HandshakeSecrets): Uint8Array {
  return hmac(sha256, secrets.phoneProofKey, concatBytes(utf8ToBytes("resume"), secrets.transcriptHash));
}

export function resumeBridgeProof(secrets: HandshakeSecrets): Uint8Array {
  return hmac(sha256, secrets.bridgeProofKey, concatBytes(utf8ToBytes("resumed"), secrets.transcriptHash));
}

/** Token that lets a phone which deleted a pairing secret ask the bridge to drop that pairing; it cannot open a session. */
export function revocationProof(pairingSecret: Uint8Array, pairingId: Uint8Array): Uint8Array {
  return hkdf(sha256, pairingSecret, pairingId, utf8ToBytes("obnixe-revoke"), proofBytes);
}

export function commitBridgeProof(opening: Uint8Array, proof: Uint8Array): Uint8Array {
  return sha256(concatBytes(utf8ToBytes("obnixe-commit"), opening, proof));
}

function sequenceNonce(sequence: number): Uint8Array {
  const nonce = new Uint8Array(12);
  let remaining = sequence;
  for (let index = 11; index >= 4; index -= 1) {
    nonce[index] = remaining % 256;
    remaining = Math.floor(remaining / 256);
  }
  return nonce;
}

/** One direction pair of an established session: seals outgoing JSON and opens incoming frames in strict order. */
export class SealedChannel {
  private readonly sendKey: Uint8Array;
  private readonly receiveKey: Uint8Array;
  private sent = 0;
  private received = 0;

  constructor(sendKey: Uint8Array, receiveKey: Uint8Array) {
    this.sendKey = sendKey;
    this.receiveKey = receiveKey;
  }

  seal(message: unknown): SealedFrame {
    const seq = this.sent;
    this.sent += 1;
    const box = chacha20poly1305(this.sendKey, sequenceNonce(seq), sealedAad).encrypt(utf8ToBytes(JSON.stringify(message)));
    return { type: "sealed", seq, box: toBase64(box) };
  }

  open(frame: SealedFrame): unknown {
    if (frame.seq !== this.received) throw new ProtocolError(`Out of order frame ${frame.seq}, expected ${this.received}`);
    const box = decodeBytes(frame.box);
    if (box.length < 16) throw new ProtocolError("Frame is too short");
    let plain: Uint8Array;
    try {
      plain = chacha20poly1305(this.receiveKey, sequenceNonce(frame.seq), sealedAad).decrypt(box);
    } catch (error) {
      if (error instanceof Error && error.message === "invalid tag") throw new ProtocolError("Frame failed authentication");
      throw error;
    }
    this.received += 1;
    return parseJson(decodeUtf8(plain));
  }
}
