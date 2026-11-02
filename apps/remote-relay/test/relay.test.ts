import { execFileSync } from "node:child_process";
import { createHash, randomFillSync } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import type { WebSocket } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseRemoteGrants, parseRelayFrame, remoteConnectUrl, remoteIdentity, remotePhoneOrigin, RemoteServer, signRemoteChallenge } from "@obnixe/core";
import type { PendingAuthorization, RemoteIdentity } from "@obnixe/core";
import { createTestContext } from "@obnixe/core/testing";
import { z } from "zod";

const root = fileURLToPath(new URL("..", import.meta.url));
const compatibilityDate = z.object({ compatibility_date: z.string() }).parse(JSON.parse(readFileSync(join(root, "wrangler.jsonc"), "utf8"))).compatibility_date;
const redirectUri = "https://claude.ai/api/mcp/auth_callback";
const verifier = "a-verifier-long-enough-to-satisfy-rfc-7636-rules-0123456789";

type PhoneMode = "answer" | "silent" | "forge";

interface FakePhone {
  readonly socket: WebSocket;
  readonly online: Promise<boolean>;
  readonly closed: Promise<number>;
  readonly pending: () => readonly PendingAuthorization[];
  readonly server: RemoteServer;
}

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  randomFillSync(bytes);
  return bytes;
}

let relay: Miniflare;

beforeAll(async () => {
  const out = mkdtempSync(join(tmpdir(), "obnixe-remote-relay-"));
  execFileSync("pnpm", ["exec", "wrangler", "deploy", "--dry-run", "--outdir", out], { cwd: root, stdio: "ignore" });
  const script = readFileSync(join(out, "worker.js"), "utf8");
  rmSync(out, { recursive: true, force: true });
  relay = new Miniflare(convertV4MiniflareOptions({ modules: true, script, compatibilityDate, durableObjects: { PHONES: { className: "PhoneLink", useSQLite: true } } }));
  await relay.ready;
}, 120_000);

afterAll(async () => {
  await relay.dispose();
});

async function connectPhone(identity: RemoteIdentity, mode: PhoneMode = "answer"): Promise<FakePhone> {
  const context = createTestContext();
  let stored = "[]";
  let pending: readonly PendingAuthorization[] = [];
  const server = new RemoteServer({
    db: context.db,
    env: context.env,
    vault: { key: new Uint8Array(32).fill(9), loadGrants: () => parseRemoteGrants(stored), saveGrants: (grants) => (stored = JSON.stringify(grants)) },
    randomBytes,
    timeZone: () => "Europe/Paris",
    listener: { onAuthorizations: (next) => (pending = next), onGrants: () => undefined },
  });
  server.setBaseUrl(remotePhoneOrigin(identity.id));
  const response = await relay.dispatchFetch(remoteConnectUrl(identity.publicKey).replace("wss:", "https:"), { headers: { upgrade: "websocket" } });
  const socket = response.webSocket;
  if (socket === null) throw new Error(`The relay refused the phone with ${response.status}`);
  socket.accept();
  let markOnline: (online: boolean) => void = () => undefined;
  const online = new Promise<boolean>((resolve) => (markOnline = resolve));
  const closed = new Promise<number>((resolve) =>
    socket.addEventListener("close", (event) => {
      markOnline(false);
      resolve(event.code);
    }),
  );
  socket.addEventListener("message", (event) => {
    const frame = typeof event.data === "string" ? parseRelayFrame(event.data) : null;
    if (frame === null) throw new Error("The relay sent a malformed frame");
    switch (frame.type) {
      case "challenge": {
        const signer = mode === "forge" ? remoteIdentity(new Uint8Array(32).fill(1)) : identity;
        socket.send(JSON.stringify({ type: "proof", signature: signRemoteChallenge({ ...signer, id: identity.id }, frame.nonce) }));
        return;
      }
      case "online":
        markOnline(true);
        return;
      case "request": {
        if (mode === "silent") return;
        const answer = server.handle({ method: frame.method, target: frame.target, headers: frame.headers, body: frame.body });
        socket.send(JSON.stringify({ type: "response", id: frame.id, ...answer }));
        return;
      }
      default: {
        const unreachable: never = frame;
        throw new Error(`Unhandled relay frame ${JSON.stringify(unreachable)}`);
      }
    }
  });
  return { socket, online, closed, pending: () => pending, server };
}

function freshIdentity(): RemoteIdentity {
  return remoteIdentity(randomBytes(32));
}

function form(values: Readonly<Record<string, string>>): string {
  return Object.entries(values)
    .map(([name, value]) => `${encodeURIComponent(name)}=${encodeURIComponent(value)}`)
    .join("&");
}

describe("phone connection", () => {
  it("brings a phone online once it proves its key", async () => {
    const phone = await connectPhone(freshIdentity());
    expect(await phone.online).toBe(true);
    phone.socket.close(1000, "done");
  });

  it("rejects a phone whose proof does not match its key", async () => {
    const identity = freshIdentity();
    const phone = await connectPhone(identity, "forge");
    expect(await phone.closed).toBe(4403);
    const response = await relay.dispatchFetch(`${remotePhoneOrigin(identity.id)}/`);
    expect(response.status).toBe(503);
  });

  it("replaces an older connection of the same phone", async () => {
    const identity = freshIdentity();
    const first = await connectPhone(identity);
    expect(await first.online).toBe(true);
    const second = await connectPhone(identity);
    expect(await second.online).toBe(true);
    expect(await first.closed).toBe(4409);
    const response = await relay.dispatchFetch(`${remotePhoneOrigin(identity.id)}/.well-known/oauth-authorization-server`);
    expect(response.status).toBe(200);
    second.socket.close(1000, "done");
  });

  it("refuses unknown hosts and malformed phone keys", async () => {
    expect((await relay.dispatchFetch("https://not-a-phone.obnixe.app/")).status).toBe(404);
    expect((await relay.dispatchFetch("https://relay.obnixe.app/connect?key=abc", { headers: { upgrade: "websocket" } })).status).toBe(400);
    expect((await relay.dispatchFetch("https://relay.obnixe.app/connect")).status).toBe(426);
  });
});

describe("agent requests", () => {
  it("tells the agent when the phone is away", async () => {
    const response = await relay.dispatchFetch(`${remotePhoneOrigin(freshIdentity().id)}/mcp`, { method: "POST", body: "{}" });
    expect(response.status).toBe(503);
    expect(await response.text()).toContain("ouvre l'application");
  });

  it("fails the waiting requests when the phone drops", async () => {
    const identity = freshIdentity();
    const phone = await connectPhone(identity, "silent");
    expect(await phone.online).toBe(true);
    const waiting = relay.dispatchFetch(`${remotePhoneOrigin(identity.id)}/`);
    await new Promise((resolve) => setTimeout(resolve, 200));
    phone.socket.close(1001, "going away");
    expect((await waiting).status).toBe(502);
  });

  it("carries the whole OAuth flow and MCP tool calls to the phone", async () => {
    const identity = freshIdentity();
    const origin = remotePhoneOrigin(identity.id);
    const phone = await connectPhone(identity);
    expect(await phone.online).toBe(true);

    const unauthenticated = await relay.dispatchFetch(`${origin}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(unauthenticated.status).toBe(401);
    expect(unauthenticated.headers.get("www-authenticate")).toContain(`${origin}/.well-known/oauth-protected-resource/mcp`);

    const metadata = (await (await relay.dispatchFetch(`${origin}/.well-known/oauth-authorization-server`)).json()) as { readonly token_endpoint: string };
    expect(metadata.token_endpoint).toBe(`${origin}/token`);

    const registration = await relay.dispatchFetch(`${origin}/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: [redirectUri], client_name: "Claude" }),
    });
    expect(registration.status).toBe(201);
    const { client_id: clientId } = (await registration.json()) as { readonly client_id: string };

    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const authorize = await relay.dispatchFetch(
      `${origin}/authorize?${form({ response_type: "code", client_id: clientId, redirect_uri: redirectUri, code_challenge: challenge, code_challenge_method: "S256", state: "s1" })}`,
    );
    expect(authorize.status).toBe(200);
    expect(authorize.headers.get("content-type")).toContain("text/html");
    const request = phone.pending()[0];
    if (request === undefined) throw new Error("The phone did not receive the authorization request");
    phone.server.decide(request.id, true);

    const status = (await (await relay.dispatchFetch(`${origin}/authorize/status?request=${request.id}`)).json()) as { readonly location: string };
    const code = new URL(status.location).searchParams.get("code") ?? "";
    const token = await relay.dispatchFetch(`${origin}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form({ grant_type: "authorization_code", code, code_verifier: verifier, client_id: clientId, redirect_uri: redirectUri }),
    });
    expect(token.status).toBe(200);
    const { access_token: access } = (await token.json()) as { readonly access_token: string };

    const call = await relay.dispatchFetch(`${origin}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${access}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_sports", arguments: {} } }),
    });
    expect(call.status).toBe(200);
    const reply = (await call.json()) as { readonly id: number; readonly result?: { readonly isError?: boolean } };
    expect(reply.id).toBe(1);
    expect(reply.result?.isError).not.toBe(true);
    phone.socket.close(1000, "done");
  });
});
