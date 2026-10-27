import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { heartbeatTimeoutMs, pairingCodeTtlMs, parsePhonePairing, parsePhoneRevocation } from "@obnixe/core";
import { generateRelayRoom, pairingRelayRoom, toBase64 } from "@obnixe/core";
import type { Frame, PairingInvite, PhonePairing } from "@obnixe/core";
import { agentConnection } from "@obnixe/schema";
import type { AgentConnection } from "@obnixe/schema";
import { AgentLink } from "@/features/agent/link";
import type { LinkNotice, LinkView } from "@/features/agent/link";
import { FakeBridge, FakeWebSocket, randomBytes } from "../../../test/fakeBridge.ts";
import { db } from "../../../test/mocks/database.ts";
import { secureItems } from "../../../test/mocks/expoSecureStore.ts";
import { reportedErrors } from "../../../test/setup.ts";

const host = "macbook.local";
const pairingKey = "obnixe.agent.pairing";
const revocationKey = "obnixe.agent.revocation";
const forgottenKey = "obnixe.agent.forgotten";

interface Recorded {
  readonly link: AgentLink;
  readonly views: LinkView[];
  readonly notices: LinkNotice[];
  readonly macs: (string | null)[];
}

let bridge: FakeBridge;
const opened: AgentLink[] = [];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  vi.setSystemTime(Date.UTC(2026, 9, 26, 20, 0));
  FakeWebSocket.reset();
  bridge = new FakeBridge();
  FakeWebSocket.bridge = bridge;
  vi.stubGlobal("WebSocket", FakeWebSocket);
});

afterEach(() => {
  for (const link of opened.splice(0)) link.dispose("screen_closed");
  vi.unstubAllGlobals();
  vi.useRealTimers();
  expect(reportedErrors).toEqual([]);
});

function openLink(at: string | null = host): Recorded {
  const views: LinkView[] = [];
  const notices: LinkNotice[] = [];
  const macs: (string | null)[] = [];
  const link = new AgentLink(at, { onView: (view) => views.push(view), onNotice: (notice) => notices.push(notice), onKnownMac: (mac) => macs.push(mac) });
  opened.push(link);
  return { link, views, notices, macs };
}

function close(recorded: Recorded): void {
  recorded.link.dispose("screen_closed");
  opened.splice(opened.indexOf(recorded.link), 1);
}

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

async function advance(ms: number): Promise<void> {
  vi.advanceTimersByTime(ms);
  await settle();
}

function pairingView(recorded: Recorded): Extract<LinkView, { kind: "pairing" }> {
  const view = recorded.link.view;
  if (view.kind !== "pairing") throw new Error(`Expected the pairing view, got ${view.kind}`);
  return view;
}

function socketAt(index: number): FakeWebSocket {
  const socket = FakeWebSocket.created[index];
  if (socket === undefined) throw new Error(`No socket ${index}`);
  return socket;
}

function lastSocket(): FakeWebSocket {
  const socket = FakeWebSocket.created.at(-1);
  if (socket === undefined) throw new Error("No socket dialed");
  return socket;
}

function frameTypes(socket: FakeWebSocket): Frame["type"][] {
  return socket.sent.map((frame) => frame.type);
}

function storedPairing(): PhonePairing | null {
  const text = secureItems.get(pairingKey);
  return text === undefined ? null : parsePhonePairing(text);
}

function connections(): AgentConnection[] {
  return db().select().from(agentConnection).all();
}

async function pairWithCode(recorded: Recorded): Promise<void> {
  const code = pairingView(recorded).code;
  await bridge.latest.typeCode(code);
  await settle();
  expect(recorded.link.view.kind).toBe("connected");
}

async function pairedLink(): Promise<Recorded> {
  const recorded = openLink();
  recorded.link.start();
  await settle();
  await pairWithCode(recorded);
  return recorded;
}

describe("code pairing", () => {
  it("pairs with the code on screen, opens a connection and keeps the Mac for next time", async () => {
    const recorded = openLink();
    expect(recorded.link.knownMac).toBeNull();
    recorded.link.start();
    expect(pairingView(recorded).network).toBe("dialing");
    await settle();
    expect(lastSocket().url).toBe("ws://macbook.local:7429");
    expect(pairingView(recorded).network).toBe("reachable");
    expect(frameTypes(lastSocket())).toEqual(["hello"]);

    await pairWithCode(recorded);
    expect(recorded.macs).toEqual(["MacBook Pro"]);
    expect(recorded.link.knownMac).toBe("MacBook Pro");
    expect(storedPairing()).toMatchObject({ bridgeName: "MacBook Pro", pairingId: bridge.knownPairings[0] });
    const [connection] = connections();
    expect(connection).toMatchObject({ client: "Cursor", host: "MacBook Pro", endedAt: null });
    expect(recorded.link.view).toMatchObject({ kind: "connected", connectionId: connection?.id });
    expect(bridge.latest.messages).toEqual([{ jsonrpc: "2.0", id: 1, result: { connectionId: connection?.id } }]);
  });

  it("rotates the code when it expires", async () => {
    const recorded = openLink();
    recorded.link.start();
    await settle();
    const first = pairingView(recorded);
    expect(first.expiresAt).toBe(Date.now() + pairingCodeTtlMs);
    await advance(pairingCodeTtlMs - 1000);
    expect(pairingView(recorded).code).toBe(first.code);
    expect(FakeWebSocket.created).toHaveLength(1);

    await advance(1000);
    const second = pairingView(recorded);
    expect(second.expiresAt).toBe(Date.now() + pairingCodeTtlMs);
    expect(second.expiresAt).toBeGreaterThan(first.expiresAt);
    expect(FakeWebSocket.created).toHaveLength(2);
    expect(FakeWebSocket.created[0]?.closed).toBe(true);
    await pairWithCode(recorded);
  });

  it("shows a new code right away once a proof exposed the current one", async () => {
    const recorded = openLink();
    recorded.link.start();
    await settle();
    const refusedCode = pairingView(recorded).code;
    await bridge.latest.typeCode(refusedCode === "000000" ? "111111" : "000000");
    await settle();
    expect(frameTypes(socketAt(0))).toEqual(["hello", "proof"]);
    expect(recorded.notices).toEqual(["code_refused"]);
    expect(FakeWebSocket.created).toHaveLength(2);
    expect(pairingView(recorded).network).toBe("reachable");

    bridge.answerProofs = false;
    await bridge.latest.typeCode(pairingView(recorded).code);
    await settle();
    expect(frameTypes(socketAt(1))).toEqual(["hello", "proof"]);
    const shown = recorded.views.length;
    lastSocket().drop();
    await settle();
    expect(FakeWebSocket.created).toHaveLength(3);
    expect(recorded.views.slice(shown).map((view) => view.kind)).toContain("pairing");
    expect(pairingView(recorded).network).toBe("reachable");
    expect(recorded.notices).toEqual(["code_refused"]);
  });

  it("redials an unreachable bridge every 3 s with the same unexposed code", async () => {
    bridge.online = false;
    const recorded = openLink();
    recorded.link.start();
    await settle();
    const code = pairingView(recorded).code;
    expect(pairingView(recorded).network).toBe("unreachable");
    await advance(2999);
    expect(FakeWebSocket.created).toHaveLength(1);
    await advance(1);
    expect(FakeWebSocket.created).toHaveLength(2);

    bridge.online = true;
    await advance(3000);
    expect(pairingView(recorded)).toMatchObject({ code, network: "reachable" });
  });

  it("waits for a host and dials as soon as one is set", async () => {
    const recorded = openLink(null);
    recorded.link.start();
    await settle();
    expect(pairingView(recorded).network).toBe("idle");
    expect(FakeWebSocket.created).toHaveLength(0);
    recorded.link.setHost("192.168.1.20:8000");
    await settle();
    expect(lastSocket().url).toBe("ws://192.168.1.20:8000");
    expect(pairingView(recorded).network).toBe("reachable");
  });
});

describe("trusted resume", () => {
  it("reconnects to the known Mac without a code", async () => {
    close(await pairedLink());
    const recorded = openLink();
    expect(recorded.link.knownMac).toBe("MacBook Pro");
    expect(recorded.link.view).toEqual({ kind: "resuming", mac: "MacBook Pro", network: "dialing", host });
    recorded.link.start();
    await settle();
    expect(recorded.link.view.kind).toBe("connected");
    expect(frameTypes(lastSocket())).toEqual(["resume", "sealed"]);
    expect(connections()).toHaveLength(2);
    expect(connections()[0]?.endReason).toBe("screen_closed");
  });

  it("redials a dropped Mac after 1 s, doubling the wait up to 30 s", async () => {
    const recorded = await pairedLink();
    bridge.online = false;
    lastSocket().drop();
    await settle();
    expect(recorded.link.view).toEqual({ kind: "resuming", mac: "MacBook Pro", network: "dialing", host });
    expect(connections()[0]?.endReason).toBe("network");

    const waits: number[] = [];
    let previous = Date.now();
    for (let attempt = 0; attempt < 7; attempt += 1) {
      const count = FakeWebSocket.created.length;
      while (FakeWebSocket.created.length === count) await advance(250);
      waits.push(lastSocket().openedAt - previous);
      previous = lastSocket().openedAt;
    }
    expect(waits).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000]);
    expect(recorded.link.view).toEqual({ kind: "resuming", mac: "MacBook Pro", network: "unreachable", host });

    bridge.online = true;
    await advance(30000);
    expect(recorded.link.view.kind).toBe("connected");
    lastSocket().drop();
    await settle();
    const dropped = Date.now();
    await advance(1000);
    expect(lastSocket().openedAt - dropped).toBe(1000);
    expect(recorded.link.view.kind).toBe("connected");
  });

  it("ends a silent connection and resumes it", async () => {
    const recorded = await pairedLink();
    await advance(heartbeatTimeoutMs);
    expect(recorded.link.view.kind).toBe("connected");
    await advance(1000);
    expect(connections()[0]?.endReason).toBe("timeout");
    expect(recorded.link.view.kind).toBe("resuming");
    await advance(1000);
    expect(recorded.link.view.kind).toBe("connected");
  });

  it("keeps a connection the bridge pings", async () => {
    const recorded = await pairedLink();
    for (let second = 0; second < 90; second += 15) {
      bridge.latest.ping();
      await advance(15_000);
    }
    expect(recorded.link.view.kind).toBe("connected");
    expect(connections()).toHaveLength(1);
  });
});

describe("refused pairing", () => {
  it("falls back to a code without deleting the pairing, since the refusal is not authenticated", async () => {
    close(await pairedLink());
    const kept = storedPairing();
    bridge.forgetAll();
    const recorded = openLink();
    recorded.link.start();
    await settle();
    expect(frameTypes(socketAt(1))).toEqual(["resume"]);
    expect(recorded.notices).toEqual(["forgotten"]);
    expect(recorded.macs).toEqual([null]);
    expect(recorded.link.knownMac).toBeNull();
    expect(pairingView(recorded).network).toBe("reachable");
    expect(storedPairing()).toEqual(kept);

    await pairWithCode(recorded);
    expect(storedPairing()?.pairingId).not.toBe(kept?.pairingId);
    expect(storedPairing()?.pairingId).toBe(bridge.knownPairings[0]);
  });

  it("shows the forgotten notice once per refused pairing", async () => {
    close(await pairedLink());
    for (const reason of ["unknown", "revoked"] as const) {
      bridge.forcedRefusal = reason;
      const refused = openLink();
      refused.link.start();
      await settle();
      expect(refused.notices).toEqual(reason === "unknown" ? ["forgotten"] : []);
      close(refused);
    }

    bridge.forcedRefusal = null;
    const resumed = openLink();
    resumed.link.start();
    await settle();
    expect(resumed.link.view.kind).toBe("connected");
    expect(secureItems.has(forgottenKey)).toBe(false);
    close(resumed);

    bridge.forcedRefusal = "revoked";
    const again = openLink();
    again.link.start();
    await settle();
    expect(again.notices).toEqual(["forgotten"]);
  });
});

describe("forgetting the Mac", () => {
  it("ends the connection, drops the pairing and resends the revocation until the bridge answers after it", async () => {
    const recorded = await pairedLink();
    const pairing = storedPairing();
    if (pairing === null) throw new Error("No stored pairing");
    bridge.ignoreRevocations = true;
    recorded.link.forget();
    expect(connections()[0]?.endReason).toBe("user");
    expect(storedPairing()).toBeNull();
    expect(recorded.macs.at(-1)).toBeNull();
    expect(parsePhoneRevocation(secureItems.get(revocationKey) ?? "")).toMatchObject({ pairingId: pairing.pairingId, bridgeId: pairing.bridgeId });
    await settle();
    expect(frameTypes(lastSocket())).toEqual(["revoke", "hello"]);
    expect(bridge.revoked).toEqual([]);

    lastSocket().drop();
    await settle();
    expect(secureItems.has(revocationKey)).toBe(true);
    bridge.ignoreRevocations = false;
    await advance(3000);
    expect(frameTypes(lastSocket())).toEqual(["revoke", "hello"]);
    expect(bridge.revoked).toEqual([pairing.pairingId]);
    expect(secureItems.has(revocationKey)).toBe(true);

    await pairWithCode(recorded);
    expect(secureItems.has(revocationKey)).toBe(false);
    expect(bridge.knownPairings).toEqual([storedPairing()?.pairingId]);

    close(recorded);
    const reopened = openLink();
    reopened.link.start();
    await settle();
    expect(frameTypes(lastSocket())).toEqual(["resume", "sealed"]);
  });

  it("does nothing without a known Mac", async () => {
    const recorded = openLink();
    recorded.link.start();
    await settle();
    recorded.link.forget();
    expect(secureItems.has(revocationKey)).toBe(false);
    expect(FakeWebSocket.created).toHaveLength(1);
  });
});

function remember(hosts: readonly string[], lastHost: string | null): void {
  const stored = storedPairing();
  if (stored === null) throw new Error("No stored pairing");
  secureItems.set(pairingKey, JSON.stringify({ ...stored, hosts, lastHost }));
}

function bridgeAt(address: string, configure: (other: FakeBridge) => void): FakeBridge {
  const other = new FakeBridge();
  configure(other);
  FakeWebSocket.bridges.set(address, other);
  return other;
}

function urls(): string[] {
  return FakeWebSocket.created.map((socket) => socket.url);
}

const relayUrl = "wss://relay.obnixe.app";
const relaySocket = "wss://relay.obnixe.app/v1";

function inviteFor(hosts: readonly string[], lifetimeMs = 300_000, relay: PairingInvite["relay"] = null): PairingInvite {
  const token = randomBytes(32);
  bridge.token = token;
  return { bridgeId: toBase64(bridge.id), token, name: "MacBook Pro", hosts, expiresAt: Date.now() + lifetimeMs, relay };
}

function offline(address: string): void {
  bridgeAt(address, (other) => {
    other.online = false;
  });
}

describe("remembered addresses", () => {
  it("tries the last good address first, then the announced ones in order, and learns the new list", async () => {
    close(await pairedLink());
    remember(["192.168.1.30:7429", "100.101.12.7:7429"], "192.168.1.30:7429");
    bridgeAt("192.168.1.30:7429", (other) => {
      other.online = false;
    });
    bridge.hosts = ["192.168.1.31:7429", "100.101.12.7:7429"];
    const recorded = openLink(null);
    recorded.link.start();
    await settle();
    expect(urls().slice(1)).toEqual(["ws://192.168.1.30:7429", "ws://100.101.12.7:7429"]);
    expect(recorded.link.view.kind).toBe("connected");
    expect(storedPairing()).toMatchObject({ lastHost: "100.101.12.7:7429", hosts: ["192.168.1.31:7429", "100.101.12.7:7429"] });
  });

  it("moves on when an address accepts the socket but never answers within 8 s", async () => {
    close(await pairedLink());
    remember(["192.168.1.30:7429", "100.101.12.7:7429"], null);
    bridgeAt("192.168.1.30:7429", (other) => {
      other.silent = true;
    });
    const recorded = openLink(null);
    recorded.link.start();
    await settle();
    expect(urls().slice(1)).toEqual(["ws://192.168.1.30:7429"]);
    await advance(7999);
    expect(urls()).toHaveLength(2);
    await advance(1);
    expect(urls().slice(1)).toEqual(["ws://192.168.1.30:7429", "ws://100.101.12.7:7429"]);
    expect(recorded.link.view.kind).toBe("connected");
  });

  it("treats another Obnixe Mac on a remembered address as the wrong host and never pairs with it", async () => {
    close(await pairedLink());
    const kept = storedPairing();
    remember(["192.168.1.30:7429", "100.101.12.7:7429"], "192.168.1.30:7429");
    const stranger = bridgeAt("192.168.1.30:7429", () => undefined);
    const recorded = openLink(null);
    recorded.link.start();
    await settle();
    expect(stranger.connections).toHaveLength(1);
    expect(frameTypes(socketAt(1))).toEqual([]);
    expect(socketAt(1).closed).toBe(true);
    expect(recorded.link.view.kind).toBe("connected");
    expect(recorded.notices).toEqual([]);
    expect(storedPairing()?.pairingId).toBe(kept?.pairingId);
  });

  it("keeps resuming with backoff when only the stranger answers", async () => {
    close(await pairedLink());
    remember(["192.168.1.30:7429"], "192.168.1.30:7429");
    bridgeAt("192.168.1.30:7429", () => undefined);
    const recorded = openLink(null);
    recorded.link.start();
    await settle();
    expect(recorded.link.view).toMatchObject({ kind: "resuming", mac: "MacBook Pro" });
    expect(FakeWebSocket.created.slice(1).flatMap((socket) => socket.sent)).toEqual([]);
    await advance(1000);
    expect(urls()).toHaveLength(3);
    expect(recorded.link.view.kind).toBe("resuming");
  });
});

describe("joining with a QR code", () => {
  it("dials the invite hosts in order, pairs with the token and keeps the relay rendezvous", async () => {
    bridgeAt("10.0.0.9:7429", (other) => {
      other.online = false;
    });
    bridge.hosts = ["192.168.1.30:7429"];
    const invite = inviteFor(["10.0.0.9:7429", "192.168.1.30:7429"], 300_000, { url: relayUrl, room: generateRelayRoom(randomBytes) });
    const recorded = openLink(null);
    recorded.link.start();
    await settle();
    recorded.link.join(invite);
    expect(recorded.link.view).toEqual({ kind: "joining", mac: "MacBook Pro", network: "dialing", host: "10.0.0.9:7429" });
    await settle();
    expect(urls()).toEqual(["ws://10.0.0.9:7429", "ws://192.168.1.30:7429"]);
    expect(lastSocket().sent[0]).toMatchObject({ type: "hello", secret: "token" });
    expect(recorded.link.view.kind).toBe("connected");
    expect(storedPairing()).toMatchObject({ bridgeId: toBase64(bridge.id), lastHost: "192.168.1.30:7429", hosts: ["192.168.1.30:7429"], relay: invite.relay });
  });

  it("stops at the invite expiry with a notice, without touching the trusted Mac", async () => {
    const recorded = await pairedLink();
    const kept = storedPairing();
    bridgeAt("10.0.0.9:7429", (other) => {
      other.online = false;
    });
    const invite = inviteFor(["10.0.0.9:7429"], 10_000);
    recorded.link.join(invite);
    await settle();
    expect(recorded.link.view).toMatchObject({ kind: "joining", network: "unreachable" });
    await advance(10_000);
    expect(recorded.notices).toEqual(["invite_expired"]);
    expect(recorded.link.view.kind).not.toBe("joining");
    const dialed = urls().length;
    await advance(10_000);
    expect(urls().slice(dialed).every((url) => url !== "ws://10.0.0.9:7429")).toBe(true);
    expect(storedPairing()).toEqual(kept);
  });

  it("ignores an invite that already expired without ending the open connection", async () => {
    const recorded = await pairedLink();
    const kept = storedPairing();
    const dialed = urls().length;
    recorded.link.join(inviteFor(["192.168.1.30:7429"], -1));
    await settle();
    expect(recorded.notices).toEqual(["invite_expired"]);
    expect(recorded.link.view.kind).toBe("connected");
    expect(urls()).toHaveLength(dialed);
    expect(connections()[0]?.endedAt).toBeNull();
    expect(storedPairing()).toEqual(kept);
  });
});

describe("single link", () => {
  it("disposes the previous link when another one starts", async () => {
    const first = openLink();
    first.link.start();
    await settle();
    const second = openLink();
    second.link.start();
    await settle();
    expect(socketAt(0).closed).toBe(true);
    expect(socketAt(1).closed).toBe(false);
    await advance(10_000);
    expect(urls()).toHaveLength(2);
  });
});

describe("relay fallback", () => {
  it("joins through the invite relay room only after every invite host failed", async () => {
    offline("10.0.0.9:7429");
    const room = generateRelayRoom(randomBytes);
    FakeWebSocket.relays.set(relaySocket, new Map([[room, bridge]]));
    const invite = inviteFor(["10.0.0.9:7429"], 300_000, { url: relayUrl, room });
    const recorded = openLink(null);
    recorded.link.start();
    await settle();
    recorded.link.join(invite);
    await settle();
    expect(urls()).toEqual(["ws://10.0.0.9:7429", relaySocket]);
    expect(recorded.link.view.kind).toBe("connected");
    expect(storedPairing()).toMatchObject({ lastHost: null, relay: { url: relayUrl, room } });
  });

  it("resumes through the room of the pairing after the typed, last good and announced hosts", async () => {
    close(await pairedLink());
    remember(["192.168.1.30:7429"], "100.101.12.7:7429");
    const stored = storedPairing();
    if (stored === null) throw new Error("No stored pairing");
    secureItems.set(pairingKey, JSON.stringify({ ...stored, relay: { url: relayUrl, room: generateRelayRoom(randomBytes) } }));
    for (const address of ["10.0.0.4:7429", "100.101.12.7:7429", "192.168.1.30:7429"]) offline(address);
    FakeWebSocket.relays.set(relaySocket, new Map([[pairingRelayRoom(stored), bridge]]));
    const recorded = openLink("10.0.0.4:7429");
    recorded.link.start();
    await settle();
    expect(urls().slice(1)).toEqual(["ws://10.0.0.4:7429", "ws://100.101.12.7:7429", "ws://192.168.1.30:7429", relaySocket]);
    expect(recorded.link.view.kind).toBe("connected");
    expect(frameTypes(lastSocket())).toEqual(["resume", "sealed"]);
  });

  it("skips a foreign bridge in the relay room like on a direct address", async () => {
    close(await pairedLink());
    remember([], null);
    const stored = storedPairing();
    if (stored === null) throw new Error("No stored pairing");
    secureItems.set(pairingKey, JSON.stringify({ ...stored, relay: { url: relayUrl, room: "unused" } }));
    offline("macbook.local:7429");
    const stranger = new FakeBridge();
    FakeWebSocket.relays.set(relaySocket, new Map([[pairingRelayRoom(stored), stranger]]));
    const recorded = openLink("macbook.local");
    recorded.link.start();
    await settle();
    expect(stranger.connections).toHaveLength(1);
    expect(lastSocket().sent).toEqual([]);
    expect(recorded.link.view.kind).toBe("resuming");
  });

  it("cancels a pending relay dial when the link hangs up", async () => {
    offline("10.0.0.9:7429");
    FakeWebSocket.relays.set(relaySocket, new Map());
    const recorded = openLink(null);
    recorded.link.start();
    await settle();
    recorded.link.join(inviteFor(["10.0.0.9:7429"], 300_000, { url: relayUrl, room: generateRelayRoom(randomBytes) }));
    await settle();
    expect(lastSocket().url).toBe(relaySocket);
    recorded.link.cancelJoin();
    await settle();
    expect(lastSocket().closed).toBe(true);
  });
});
