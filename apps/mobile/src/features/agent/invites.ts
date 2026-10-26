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

export function readInvite(text: string): Extract<PairingRequest, { kind: "invite" | "invalid" }> {
  try {
    return { kind: "invite", invite: parseInvite(text) };
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

export function deliverPairingRequest(request: PairingRequest): void {
  pending = request;
  for (const listener of listeners) listener();
}

/** Calls `handle` with each request delivered while mounted, and with one delivered before, such as a cold-start deep link. */
export function usePairingRequests(handle: (request: PairingRequest) => void): void {
  const handleRef = useRef(handle);
  handleRef.current = handle;
  useEffect(() => {
    const take = (): void => {
      const request = pending;
      pending = null;
      if (request !== null) handleRef.current(request);
    };
    take();
    listeners.add(take);
    return () => {
      listeners.delete(take);
    };
  }, []);
}
