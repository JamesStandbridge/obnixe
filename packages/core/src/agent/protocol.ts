import { chacha20poly1305 } from "@noble/ciphers/chacha.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { hmac } from "@noble/hashes/hmac.js";
import { scryptAsync } from "@noble/hashes/scrypt.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { concatBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { z } from "zod";
import { connectionEndReasons } from "@obnixe/schema";
import { Base64Error, Utf8Error, fromBase64, fromUtf8, toBase64 } from "./encoding.ts";

export const protocolVersion = 1;
export const defaultPhonePort = 7429;
export const defaultControlPort = 7430;
export const pairingCodeTtlMs = 5 * 60_000;
export const maxPairingAttempts = 5;
export const heartbeatIntervalMs = 15_000;
export const heartbeatTimeoutMs = 45_000;
export const nonceBytes = 32;

const scryptCost = { N: 2 ** 14, r: 8, p: 1, dkLen: 32 } as const;
const sealedAad = utf8ToBytes("obnixe-sealed-v1");

export class ProtocolError extends Error {}

const base64 = z.string().regex(/^[A-Za-z0-9+/]*={0,2}$/);

export const rejectionReasons = ["code", "expired", "replaced", "version"] as const;
export type RejectionReason = (typeof rejectionReasons)[number];

const frameSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("challenge"), version: z.int(), nonce: base64 }),
  z.object({ type: z.literal("hello"), version: z.int(), device: z.string().min(1).max(64), nonce: base64, proof: base64 }),
  z.object({ type: z.literal("welcome"), proof: base64 }),
  z.object({ type: z.literal("rejected"), reason: z.enum(rejectionReasons) }),
  z.object({ type: z.literal("sealed"), seq: z.int().nonnegative(), box: base64 }),
]);

/**
 * Plaintext frames exchanged on the phone WebSocket.
 *
 * 1. bridge -> phone `challenge` with a random nonce.
 * 2. phone -> bridge `hello` with its own nonce and an HMAC proof keyed by scrypt(code, nonces); the raw code never travels.
 * 3. The bridge holds the hello until `obnixe-bridge pair` posts the code typed by the user on the control port, then
 *    answers `welcome` with its own proof (or `rejected`). Both sides derive directional ChaCha20-Poly1305 keys with HKDF.
 * 4. Every later message is a `sealed` JSON-RPC payload with a strictly increasing per-direction sequence number.
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
  z.object({ jsonrpc: jsonRpc, id: z.int(), method: z.literal("session.open"), params: z.object({ client: z.string(), host: z.string() }) }),
  z.object({ jsonrpc: jsonRpc, id: z.int(), method: z.literal("tools/call"), params: z.object({ name: z.string(), arguments: z.record(z.string(), z.unknown()) }) }),
  z.object({ jsonrpc: jsonRpc, method: z.literal("session.client"), params: z.object({ client: z.string() }) }),
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

export interface PairingTranscript {
  readonly bridgeNonce: Uint8Array;
  readonly phoneNonce: Uint8Array;
  readonly device: string;
}

function transcriptBytes(transcript: PairingTranscript): Uint8Array {
  return concatBytes(utf8ToBytes(`obnixe-v${protocolVersion}`), transcript.bridgeNonce, transcript.phoneNonce, utf8ToBytes(transcript.device));
}

export function derivePairingKey(code: string, transcript: PairingTranscript): Promise<Uint8Array> {
  const salt = concatBytes(utf8ToBytes("obnixe-pair"), transcript.bridgeNonce, transcript.phoneNonce);
  return scryptAsync(utf8ToBytes(code), salt, scryptCost);
}

export function helloProof(pairingKey: Uint8Array, transcript: PairingTranscript): Uint8Array {
  return hmac(sha256, pairingKey, concatBytes(utf8ToBytes("hello"), transcriptBytes(transcript)));
}

export function welcomeProof(pairingKey: Uint8Array, transcript: PairingTranscript): Uint8Array {
  return hmac(sha256, pairingKey, concatBytes(utf8ToBytes("welcome"), transcriptBytes(transcript)));
}

export function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  return difference === 0;
}

export interface SessionKeys {
  readonly toPhone: Uint8Array;
  readonly toBridge: Uint8Array;
}

export function deriveSessionKeys(pairingKey: Uint8Array, transcript: PairingTranscript): SessionKeys {
  const material = hkdf(sha256, pairingKey, transcriptBytes(transcript), utf8ToBytes("obnixe-session"), 64);
  return { toPhone: material.slice(0, 32), toBridge: material.slice(32, 64) };
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
