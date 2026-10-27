import { z } from "zod";
import { Base64Error, fromBase64, fromBase64Url, toBase64, toBase64Url } from "./encoding.ts";
import { phoneHostsSchema } from "./hosts.ts";

export const inviteVersion = 1;
export const inviteScheme = "obnixe://pair";
export const pairingTokenBytes = 32;
export const inviteTtlMs = 5 * 60_000;
export const maxInviteNameLength = 64;

const inviteBridgeIdBytes = 16;
const maxRoomBytes = 64;
const relayUrlPattern = /^wss:\/\/[A-Za-z0-9](?:[A-Za-z0-9.-]{0,252}[A-Za-z0-9])?(?::\d{1,5})?(?:\/[A-Za-z0-9._~%/-]*)?$/;

export type InviteErrorReason = "format" | "version" | "expired";

export class InviteError extends Error {
  readonly reason: InviteErrorReason;

  constructor(reason: InviteErrorReason, message: string) {
    super(message);
    this.reason = reason;
  }
}

/** Relay rendezvous advertised by a bridge that has OBNIXE_RELAY_URL; the room id stays base64url. */
export interface RelayEndpoint {
  readonly url: string;
  readonly room: string;
}

/**
 * Content of the QR code shown by `obnixe-bridge pair`: who the bridge is, the one-time pairing token that replaces the
 * code, where to dial it and when the token expires. `bridgeId` is standard base64 like every other identity of the
 * protocol; `expiresAt` is in milliseconds, carried in whole seconds.
 */
export interface PairingInvite {
  readonly bridgeId: string;
  readonly token: Uint8Array;
  readonly name: string;
  readonly hosts: readonly string[];
  readonly expiresAt: number;
  readonly relay: RelayEndpoint | null;
}

/** Truncates to whole code points so a name never ends with half a surrogate pair. */
export function truncateName(name: string): string {
  return Array.from(name).slice(0, maxInviteNameLength).join("");
}

export function isRelayUrl(text: string): boolean {
  return text.length <= 512 && relayUrlPattern.test(text);
}

function base64UrlBytes(minimum: number, maximum: number) {
  return z.string().transform((text, context) => {
    let bytes: Uint8Array;
    try {
      bytes = fromBase64Url(text);
    } catch (error) {
      if (!(error instanceof Base64Error)) throw error;
      context.addIssue({ code: "custom", message: error.message });
      return z.NEVER;
    }
    if (bytes.length < minimum || bytes.length > maximum) {
      context.addIssue({ code: "custom", message: `Expected ${minimum === maximum ? minimum : `${minimum} to ${maximum}`} bytes, got ${bytes.length}` });
      return z.NEVER;
    }
    return bytes;
  });
}

const querySchema = z
  .strictObject({
    v: z.literal(String(inviteVersion)),
    b: base64UrlBytes(inviteBridgeIdBytes, inviteBridgeIdBytes),
    t: base64UrlBytes(pairingTokenBytes, pairingTokenBytes),
    n: z
      .string()
      .trim()
      .min(1)
      .refine((name) => Array.from(name).length <= maxInviteNameLength, "Name too long"),
    h: z
      .string()
      .transform((text) => text.split(","))
      .pipe(phoneHostsSchema)
      .refine((hosts) => hosts.length > 0, "No host"),
    e: z
      .string()
      .regex(/^[1-9]\d{0,11}$/)
      .transform((seconds) => Number(seconds) * 1000),
    r: z.string().refine(isRelayUrl, "Expected a wss:// URL").optional(),
    room: base64UrlBytes(1, maxRoomBytes).optional(),
  })
  .refine((query) => (query.r === undefined) === (query.room === undefined), "r and room go together");

function decodeComponent(text: string): string {
  try {
    return decodeURIComponent(text.replace(/\+/g, " "));
  } catch (error) {
    if (error instanceof URIError) throw new InviteError("format", "Invalid percent-encoding");
    throw error;
  }
}

function queryOf(text: string): Record<string, string> {
  const prefix = `${inviteScheme}?`;
  if (!text.startsWith(prefix)) throw new InviteError("format", "Not an Obnixe pairing link");
  const query = new Map<string, string>();
  for (const part of text.slice(prefix.length).split("&")) {
    const separator = part.indexOf("=");
    if (separator <= 0) throw new InviteError("format", `Malformed parameter ${part}`);
    const key = decodeComponent(part.slice(0, separator));
    if (query.has(key)) throw new InviteError("format", `Duplicate parameter ${key}`);
    query.set(key, decodeComponent(part.slice(separator + 1)));
  }
  return Object.fromEntries(query);
}

/** Parses the text of a scanned QR code or an opened deep link at time `now`; throws an InviteError for anything else or a stale invite. */
export function parseInvite(text: string, now: number): PairingInvite {
  const query = queryOf(text.trim());
  const version = query.v;
  if (version !== String(inviteVersion)) {
    throw new InviteError(version !== undefined && /^\d+$/.test(version) ? "version" : "format", `Unsupported invite version ${version ?? "(none)"}`);
  }
  const parsed = querySchema.safeParse(query);
  if (!parsed.success) throw new InviteError("format", `Malformed invite: ${parsed.error.message}`);
  const { b, t, n, h, e, r, room } = parsed.data;
  if (e <= now) throw new InviteError("expired", "The invite expired");
  return { bridgeId: toBase64(b), token: t, name: n, hosts: h, expiresAt: e, relay: r === undefined || room === undefined ? null : { url: r, room: toBase64Url(room) } };
}

interface Parameter {
  readonly key: string;
  readonly value: string;
}

export function formatInvite(invite: PairingInvite): string {
  const parameters: Parameter[] = [
    { key: "v", value: String(inviteVersion) },
    { key: "b", value: toBase64Url(fromBase64(invite.bridgeId)) },
    { key: "t", value: toBase64Url(invite.token) },
    { key: "n", value: encodeURIComponent(invite.name) },
    { key: "h", value: invite.hosts.join(",") },
    { key: "e", value: String(Math.floor(invite.expiresAt / 1000)) },
  ];
  if (invite.relay !== null) parameters.push({ key: "r", value: encodeURIComponent(invite.relay.url) }, { key: "room", value: invite.relay.room });
  return `${inviteScheme}?${parameters.map((parameter) => `${parameter.key}=${parameter.value}`).join("&")}`;
}
