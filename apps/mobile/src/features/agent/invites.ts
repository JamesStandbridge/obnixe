import { useEffect, useRef } from "react";
import { InviteError, inviteScheme, parseInvite } from "@obnixe/core";
import type { InviteErrorReason, PairingInvite } from "@obnixe/core";

/** What the scanner or a deep link hands to the Agent screen. */
export type PairingRequest =
  | { readonly kind: "invite"; readonly invite: PairingInvite }
  | { readonly kind: "invalid"; readonly reason: InviteErrorReason }
  | { readonly kind: "manual" };

let pending: PairingRequest | null = null;
const listeners = new Set<() => void>();

export function readInvite(text: string, now: number): Extract<PairingRequest, { kind: "invite" | "invalid" }> {
  try {
    return { kind: "invite", invite: parseInvite(text, now) };
  } catch (error) {
    if (error instanceof InviteError) return { kind: "invalid", reason: error.reason };
    throw error;
  }
}

/**
 * The invite URL of a system deep link, or null for any other link. Expo Go strips its own scheme and passes
 * `/pair?...`; a standalone build passes the full `obnixe://pair?...`.
 */
export function inviteLink(path: string): string | null {
  if (path.startsWith(`${inviteScheme}?`)) return path;
  const match = /^\/?pair\?(.*)$/.exec(path);
  return match === null ? null : `${inviteScheme}?${match[1] ?? ""}`;
}

export function inviteProblemText(reason: InviteErrorReason): string {
  switch (reason) {
    case "format":
      return "Ce QR code ne vient pas d'obnixe-bridge";
    case "version":
      return "QR code trop récent, mets à jour Obnixe";
    case "expired":
      return "QR code expiré, relance obnixe-bridge pair sur le Mac";
    default: {
      const unreachable: never = reason;
      return unreachable;
    }
  }
}

/** True while an Agent screen is mounted to take requests, so a deep link must not open a second one. */
export function hasPairingListener(): boolean {
  return listeners.size > 0;
}

export function deliverPairingRequest(request: PairingRequest): void {
  pending = request;
  for (const listener of listeners) listener();
}

/** Calls `handle` with a request delivered before, such as a cold-start deep link, then with each later one until unsubscribed. */
export function subscribePairingRequests(handle: (request: PairingRequest) => void): () => void {
  const take = (): void => {
    const request = pending;
    pending = null;
    if (request !== null) handle(request);
  };
  take();
  listeners.add(take);
  return () => {
    listeners.delete(take);
  };
}

export function usePairingRequests(handle: (request: PairingRequest) => void): void {
  const handleRef = useRef(handle);
  handleRef.current = handle;
  useEffect(() => subscribePairingRequests((request) => handleRef.current(request)), []);
}
