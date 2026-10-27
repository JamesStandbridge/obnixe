import { describe, expect, it } from "vitest";
import { formatInvite, toBase64 } from "@obnixe/core";
import type { PairingInvite } from "@obnixe/core";
import { redirectSystemPath } from "@/app/+native-intent";
import { inviteLink, readInvite, subscribePairingRequests } from "@/features/agent/invites";
import type { PairingRequest } from "@/features/agent/invites";
import { randomBytes } from "../../../test/fakeBridge.ts";

function invite(expiresAt: number): PairingInvite {
  return { bridgeId: toBase64(randomBytes(16)), token: randomBytes(32), name: "MacBook Pro", hosts: ["192.168.1.24:7429"], expiresAt: Math.floor(expiresAt / 1000) * 1000, relay: null };
}

describe("inviteLink", () => {
  it("keeps a standalone link and rebuilds the one Expo Go hands over", () => {
    const url = formatInvite(invite(Date.now() + 60_000));
    const query = url.slice(url.indexOf("?") + 1);
    expect(inviteLink(url)).toBe(url);
    expect(inviteLink(`/pair?${query}`)).toBe(url);
    expect(inviteLink(`pair?${query}`)).toBe(url);
  });

  it("ignores every other link", () => {
    for (const path of ["/agent", "obnixe://agent", "/pairing?v=1", "https://obnixe.app/pair?v=1", "obnixe://pair"]) expect(inviteLink(path)).toBeNull();
  });
});

describe("redirectSystemPath", () => {
  it("opens the Agent screen for a pairing link and leaves other links alone", () => {
    const fresh = invite(Date.now() + 60_000);
    expect(redirectSystemPath({ path: "/settings", initial: false })).toBe("/settings");
    expect(redirectSystemPath({ path: formatInvite(fresh), initial: true })).toBe("/agent");
    const received: PairingRequest[] = [];
    const unsubscribe = subscribePairingRequests((request) => received.push(request));
    expect(received).toEqual([{ kind: "invite", invite: fresh }]);
    unsubscribe();
  });

  it("stays on the open Agent screen instead of pushing a second one", () => {
    const received: PairingRequest[] = [];
    const unsubscribe = subscribePairingRequests((request) => received.push(request));
    const fresh = invite(Date.now() + 60_000);
    expect(redirectSystemPath({ path: formatInvite(fresh), initial: false })).toBeNull();
    expect(received).toEqual([{ kind: "invite", invite: fresh }]);
    unsubscribe();
  });

  it("drops a stale link, from Recents or a cold start, as an expired request", () => {
    const received: PairingRequest[] = [];
    const unsubscribe = subscribePairingRequests((request) => received.push(request));
    expect(redirectSystemPath({ path: formatInvite(invite(Date.now() - 1000)), initial: true })).toBeNull();
    expect(received).toEqual([{ kind: "invalid", reason: "expired" }]);
    expect(readInvite("obnixe://pair?v=9", Date.now())).toEqual({ kind: "invalid", reason: "version" });
    unsubscribe();
  });
});
