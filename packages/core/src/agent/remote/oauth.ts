import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { utf8ToBytes } from "@noble/hashes/utils.js";
import { z } from "zod";
import type { EpochMs, Id } from "@obnixe/schema";
import { sameBytes } from "../../bytes.ts";
import { Base64Error, Utf8Error, fromBase64Url, fromUtf8, toBase64Url } from "../encoding.ts";
import type { RandomBytes } from "../protocol.ts";
import { formQuery } from "./http.ts";

export const accessTokenTtlMs = 60 * 60_000;
/** How long a refresh token stays usable after it was rotated, so a client retrying a lost answer is not locked out. */
export const refreshGraceMs = 2 * 60_000;
export const remoteScope = "obnixe";
const tokenBytes = 32;
const clientMacBytes = 16;

const remoteGrantSchema = z.object({
  id: z.string(),
  clientId: z.string(),
  client: z.string(),
  connectionId: z.string(),
  accessHash: z.string(),
  accessExpiresAt: z.number(),
  refreshHash: z.string(),
  previousRefreshHash: z.string().nullable(),
  rotatedAt: z.number(),
  createdAt: z.number(),
});

/** An access the user approved for one agent client; only hashes of its tokens are kept. */
export interface RemoteGrant {
  readonly id: string;
  readonly clientId: string;
  readonly client: string;
  readonly connectionId: Id;
  readonly accessHash: string;
  readonly accessExpiresAt: EpochMs;
  readonly refreshHash: string;
  readonly previousRefreshHash: string | null;
  readonly rotatedAt: EpochMs;
  readonly createdAt: EpochMs;
}

function parseStored(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

/** Reads stored grants, dropping the ones that no longer parse. */
export function parseRemoteGrants(text: string): readonly RemoteGrant[] {
  const parsed = z.array(z.unknown()).safeParse(parseStored(text));
  if (!parsed.success) return [];
  return parsed.data.flatMap((value) => {
    const grant = remoteGrantSchema.safeParse(value);
    return grant.success ? [grant.data as RemoteGrant] : [];
  });
}

export function hashToken(token: string): string {
  return toBase64Url(sha256(utf8ToBytes(token)));
}

export function newToken(randomBytes: RandomBytes): string {
  return toBase64Url(randomBytes(tokenBytes));
}

/** RFC 7636 S256: the challenge is the unpadded base64url SHA-256 of the verifier. */
export function verifiesChallenge(verifier: string, challenge: string): boolean {
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) return false;
  return toBase64Url(sha256(utf8ToBytes(verifier))) === challenge;
}

/** A client registered by dynamic client registration; it is not stored but signed into its client id. */
export interface RegisteredClient {
  readonly name: string;
  readonly redirectUris: readonly string[];
}

const registeredClientSchema = z.object({ n: z.string(), r: z.array(z.string()).min(1) });

function clientMac(key: Uint8Array, payload: string): Uint8Array {
  return hmac(sha256, key, utf8ToBytes(payload)).slice(0, clientMacBytes);
}

export function encodeClientId(key: Uint8Array, client: RegisteredClient): string {
  const payload = toBase64Url(utf8ToBytes(JSON.stringify({ n: client.name, r: client.redirectUris })));
  return `${payload}.${toBase64Url(clientMac(key, payload))}`;
}

/** Returns the client signed into `clientId` by this phone, or null for any other id. */
export function decodeClientId(key: Uint8Array, clientId: string): RegisteredClient | null {
  const [payload, mac, extra] = clientId.split(".");
  if (payload === undefined || mac === undefined || extra !== undefined) return null;
  try {
    if (!sameBytes(fromBase64Url(mac), clientMac(key, payload))) return null;
    const parsed = registeredClientSchema.safeParse(parseStored(fromUtf8(fromBase64Url(payload))));
    return parsed.success ? { name: parsed.data.n, redirectUris: parsed.data.r } : null;
  } catch (error) {
    if (error instanceof Base64Error || error instanceof Utf8Error) return null;
    throw error;
  }
}

const loopbackHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Redirect URIs a client may register: HTTPS anywhere, plain HTTP only back to the machine running the client. */
export function isAllowedRedirectUri(uri: string): boolean {
  if (uri.length > 2000 || /[\s#]/.test(uri)) return false;
  const match = /^(https?):\/\/(\[[0-9a-fA-F:.]+\]|[A-Za-z0-9.-]+)(?::\d{1,5})?(?:[/?].*)?$/.exec(uri);
  if (match === null) return false;
  const [, scheme, host] = match;
  if (scheme === "https") return true;
  return host !== undefined && loopbackHosts.has(host.toLowerCase());
}

/** Host shown to the user when they approve a client, so a redirect to an unexpected site stands out. */
export function redirectHost(uri: string): string {
  const match = /^https?:\/\/([^/?:]+|\[[^\]]+\])/.exec(uri);
  return match?.[1] ?? uri;
}

export function withQuery(uri: string, values: Readonly<Record<string, string>>): string {
  return `${uri}${uri.includes("?") ? "&" : "?"}${formQuery(values)}`;
}
