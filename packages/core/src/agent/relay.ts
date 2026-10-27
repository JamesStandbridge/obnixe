import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { utf8ToBytes } from "@noble/hashes/utils.js";
import { z } from "zod";
import { toBase64Url } from "./encoding.ts";
import { ProtocolError, decodeBytes, identityBytes, pairingSecretBytes } from "./protocol.ts";
import type { RandomBytes } from "./protocol.ts";

export const relayProtocolVersion = 1;
export const relayPath = "/v1";
export const relayRoomBytes = 32;
/** Relay used when OBNIXE_RELAY_URL is not set; empty until a public relay is deployed. */
export const defaultRelayUrl = "";

const roomPattern = /^[A-Za-z0-9_-]{43}$/;
const relayUrlPattern = /^wss?:\/\/[^\s/?#]+(?:\/[^\s?#]*)?$/;

export function isRelayRoom(text: string): boolean {
  return roomPattern.test(text);
}

export function isRelayUrl(text: string): boolean {
  return relayUrlPattern.test(text);
}

/** WebSocket endpoint of a relay given by its base URL, such as `wss://relay.example.com`. */
export function relaySocketUrl(relayUrl: string): string {
  return `${relayUrl.replace(/\/+$/, "")}${relayPath}`;
}

/** Room of a trusted pairing. One-way from the pairing secret, so the relay learns nothing it could link to the secret or the pairing id. */
export function deriveRelayRoom(pairingSecret: Uint8Array, pairingId: Uint8Array): Uint8Array {
  return hkdf(sha256, pairingSecret, utf8ToBytes("obnixe-relay-room"), pairingId, relayRoomBytes);
}

/** Fields shared by the bridge and phone pairing records, both base64. */
export interface RoomPairing {
  readonly pairingId: string;
  readonly secret: string;
}

export function pairingRelayRoom(pairing: RoomPairing): string {
  return toBase64Url(deriveRelayRoom(decodeBytes(pairing.secret, pairingSecretBytes), decodeBytes(pairing.pairingId, identityBytes)));
}

/** One-time room of a pending invite, carried by the QR code. */
export function generateRelayRoom(randomBytes: RandomBytes): string {
  return toBase64Url(randomBytes(relayRoomBytes));
}

export const relayRoles = ["bridge", "phone"] as const;
export type RelayRole = (typeof relayRoles)[number];

/** `occupied`: the room already holds that role. `rooms`: the connection holds too many rooms. `busy`: the relay is full. `version`: unsupported `v`. */
export const relayRefusals = ["occupied", "rooms", "busy", "version"] as const;
export type RelayRefusal = (typeof relayRefusals)[number];

export interface RelayJoin {
  readonly type: "join";
  readonly v: typeof relayProtocolVersion;
  readonly role: RelayRole;
  readonly room: string;
}

/**
 * Messages a client sends to the relay; a phone only ever sends its `join`. One bridge connection holds several rooms, so everything is tagged with its room;
 * `data` is a protocol frame passed verbatim to the phone of that room and `close` hangs up that phone.
 */
export type RelayClientMessage =
  | RelayJoin
  | { readonly type: "leave"; readonly room: string }
  | { readonly type: "frame"; readonly room: string; readonly data: string }
  | { readonly type: "close"; readonly room: string };

const room = z.string().regex(roomPattern);

const relayToBridgeSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("joined"), room }),
  z.object({ type: z.literal("refused"), room, reason: z.enum(relayRefusals) }),
  z.object({ type: z.literal("peer"), room }),
  z.object({ type: z.literal("frame"), room, data: z.string() }),
  z.object({ type: z.literal("peer_left"), room }),
]);

/** Messages the relay sends to a bridge; `frame.data` is the verbatim text the phone of that room sent. */
export type RelayToBridge = z.infer<typeof relayToBridgeSchema>;

const relayToPhoneSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("peer") }),
  z.object({ type: z.literal("refused"), reason: z.enum(relayRefusals) }),
  z.object({ type: z.literal("peer_left") }),
]);

/**
 * Messages the relay sends to a phone. After `peer`, every text frame is the verbatim output of the bridge except the
 * final `peer_left`, sent as exactly {@link relayPeerLeftMessage} right before the relay closes the socket.
 */
export type RelayToPhone = z.infer<typeof relayToPhoneSchema>;

export const relayPeerLeftMessage = JSON.stringify({ type: "peer_left" });

export function encodeRelayMessage(message: RelayClientMessage): string {
  return JSON.stringify(message);
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    if (error instanceof SyntaxError) throw new ProtocolError(`Relay message is not JSON: ${error.message}`);
    throw error;
  }
}

export function parseRelayToBridge(text: string): RelayToBridge {
  const parsed = relayToBridgeSchema.safeParse(parseJson(text));
  if (!parsed.success) throw new ProtocolError(`Unexpected relay message: ${parsed.error.message}`);
  return parsed.data;
}

export function parseRelayToPhone(text: string): RelayToPhone {
  const parsed = relayToPhoneSchema.safeParse(parseJson(text));
  if (!parsed.success) throw new ProtocolError(`Unexpected relay message: ${parsed.error.message}`);
  return parsed.data;
}
