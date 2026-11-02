import { randomFillSync } from "node:crypto";
import { sha256 } from "@noble/hashes/sha2.js";
import { utf8ToBytes } from "@noble/hashes/utils.js";
import { beforeEach, describe, expect, it } from "vitest";
import { agentCall, agentConnection, settings } from "@obnixe/schema";
import { createTestContext } from "../../testing.ts";
import type { TestContext } from "../../testing.ts";
import { toBase64Url } from "../encoding.ts";
import { parseForm, parseTarget } from "./http.ts";
import type { RemoteRequest, RemoteResponse } from "./http.ts";
import { decodeClientId, isAllowedRedirectUri, parseRemoteGrants, verifiesChallenge } from "./oauth.ts";
import type { RemoteGrant } from "./oauth.ts";
import { RemoteServer } from "./server.ts";
import type { PendingAuthorization } from "./server.ts";

const base = "https://abcdefghijklmnopqrstuvwxyz.obnixe.app";
const redirectUri = "https://claude.ai/api/mcp/auth_callback";
const verifier = "a-verifier-long-enough-to-satisfy-rfc-7636-rules-0123456789";
const challenge = toBase64Url(sha256(utf8ToBytes(verifier)));

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  randomFillSync(bytes);
  return bytes;
}

let context: TestContext;
let stored: string;
let pending: readonly PendingAuthorization[];
let server: RemoteServer;

function createServer(): RemoteServer {
  const created = new RemoteServer({
    db: context.db,
    env: context.env,
    vault: { key: new Uint8Array(32).fill(7), loadGrants: () => parseRemoteGrants(stored), saveGrants: (grants) => (stored = JSON.stringify(grants)) },
    randomBytes,
    timeZone: () => "Europe/Paris",
    listener: { onAuthorizations: (next) => (pending = next), onGrants: () => undefined },
  });
  created.setBaseUrl(base);
  return created;
}

beforeEach(() => {
  context = createTestContext();
  context.db
    .insert(settings)
    .values({
      singleton: 1,
      theme: "dark",
      massUnit: "kg",
      agentCanReadBody: false,
      agentCanWrite: false,
      agentCanReadPhotos: false,
      reminderWeekdays: 0,
      reminderMinutes: 1110,
      remindersExportedAt: null,
      agentChangesSeenAt: null,
      bridgeHost: null,
      updatedAt: context.env.now(),
    })
    .run();
  stored = "[]";
  pending = [];
  server = createServer();
});

function send(method: string, target: string, body = "", headers: Record<string, string> = {}): RemoteResponse {
  const request: RemoteRequest = { method, target, headers, body };
  return server.handle(request);
}

function json<T>(response: RemoteResponse): T {
  return JSON.parse(response.body) as T;
}

function form(values: Record<string, string>): string {
  return new URLSearchParams(values).toString();
}

function register(): string {
  const response = send("POST", "/register", JSON.stringify({ client_name: "claudeai", redirect_uris: [redirectUri] }), { "content-type": "application/json" });
  expect(response.status).toBe(201);
  return json<{ client_id: string }>(response).client_id;
}

function authorizeTarget(clientId: string): string {
  return `/authorize?${form({ response_type: "code", client_id: clientId, redirect_uri: redirectUri, code_challenge: challenge, code_challenge_method: "S256", state: "xyz", scope: "obnixe" })}`;
}

function approvedCode(clientId: string): string {
  expect(send("GET", authorizeTarget(clientId)).status).toBe(200);
  const request = pending[0];
  if (request === undefined) throw new Error("No pending authorization");
  server.decide(request.id, true);
  const status = json<{ status: string; location: string }>(send("GET", `/authorize/status?request=${request.id}`));
  expect(status.status).toBe("done");
  const query = parseTarget(status.location.slice(redirectUri.length)).query;
  expect(query.get("state")).toBe("xyz");
  expect(query.get("iss")).toBe(base);
  return query.get("code") ?? "";
}

interface Tokens {
  readonly access_token: string;
  readonly refresh_token: string;
  readonly expires_in: number;
}

function exchange(clientId: string, code: string): RemoteResponse {
  return send("POST", "/token", form({ grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: redirectUri, client_id: clientId }), {
    "content-type": "application/x-www-form-urlencoded",
  });
}

function connect(): Tokens & { readonly clientId: string } {
  const clientId = register();
  const response = exchange(clientId, approvedCode(clientId));
  expect(response.status).toBe(200);
  return { ...json<Tokens>(response), clientId };
}

function rpc(token: string, message: unknown): RemoteResponse {
  return send("POST", "/mcp", JSON.stringify(message), { authorization: `Bearer ${token}`, "content-type": "application/json" });
}

describe("discovery", () => {
  it("points an unauthenticated MCP client to the phone's authorization server", () => {
    const refused = send("POST", "/mcp", "{}");
    expect(refused.status).toBe(401);
    expect(refused.headers["www-authenticate"]).toContain(`${base}/.well-known/oauth-protected-resource/mcp`);
    const resource = json<{ resource: string; authorization_servers: string[] }>(send("GET", "/.well-known/oauth-protected-resource/mcp"));
    expect(resource).toMatchObject({ resource: `${base}/mcp`, authorization_servers: [base] });
    const metadata = json<Record<string, unknown>>(send("GET", "/.well-known/oauth-authorization-server"));
    expect(metadata).toMatchObject({ issuer: base, token_endpoint: `${base}/token`, registration_endpoint: `${base}/register`, code_challenge_methods_supported: ["S256"] });
  });

  it("answers nothing until the tunnel URL is known", () => {
    server.setBaseUrl(null);
    expect(send("GET", "/.well-known/oauth-authorization-server").status).toBe(503);
  });
});

describe("authorization", () => {
  it("signs registered clients into their id and rejects tampered ones", () => {
    const clientId = register();
    expect(decodeClientId(new Uint8Array(32).fill(7), clientId)).toEqual({ name: "Claude", redirectUris: [redirectUri] });
    expect(decodeClientId(new Uint8Array(32).fill(8), clientId)).toBeNull();
    expect(send("GET", authorizeTarget(`${clientId}x`)).status).toBe(400);
  });

  it("only accepts HTTPS redirects, or HTTP back to the local machine", () => {
    expect(isAllowedRedirectUri(redirectUri)).toBe(true);
    expect(isAllowedRedirectUri("http://127.0.0.1:33418/callback")).toBe(true);
    expect(isAllowedRedirectUri("http://evil.example/callback")).toBe(false);
    expect(isAllowedRedirectUri("javascript:alert(1)")).toBe(false);
    const response = send("POST", "/register", JSON.stringify({ redirect_uris: ["http://evil.example/cb"] }));
    expect(json<{ error: string }>(response).error).toBe("invalid_redirect_uri");
  });

  it("waits for the user on the phone and sends a refusal back to the client", () => {
    const clientId = register();
    const page = send("GET", authorizeTarget(clientId));
    expect(page.headers["content-type"]).toContain("text/html");
    expect(page.body).toContain("Claude demande l'accès");
    expect(pending).toEqual([expect.objectContaining({ client: "Claude", host: "claude.ai" })]);
    const id = pending[0]?.id ?? "";
    expect(json<{ status: string }>(send("GET", `/authorize/status?request=${id}`)).status).toBe("pending");
    server.decide(id, false);
    expect(pending).toEqual([]);
    const status = json<{ location: string }>(send("GET", `/authorize/status?request=${id}`));
    expect(status.location).toBe(`${redirectUri}?error=access_denied&state=xyz&iss=${encodeURIComponent(base)}`);
  });

  it("forgets an unanswered request after ten minutes", () => {
    send("GET", authorizeTarget(register()));
    const id = pending[0]?.id ?? "";
    context.advance(10 * 60_000);
    expect(json<{ status: string }>(send("GET", `/authorize/status?request=${id}`)).status).toBe("expired");
    expect(pending).toEqual([]);
  });

  it("redirects without PKCE to an error", () => {
    const clientId = register();
    const response = send("GET", `/authorize?${form({ response_type: "code", client_id: clientId, redirect_uri: redirectUri, state: "s" })}`);
    expect(response.status).toBe(302);
    expect(response.headers.location).toContain("error=invalid_request");
  });

  it("checks the code verifier and uses each code once", () => {
    const clientId = register();
    const code = approvedCode(clientId);
    const wrong = send("POST", "/token", form({ grant_type: "authorization_code", code, code_verifier: `${verifier}x`, client_id: clientId }));
    expect(json<{ error: string }>(wrong).error).toBe("invalid_grant");
    expect(exchange(clientId, code).status).toBe(400);
    expect(verifiesChallenge("short", challenge)).toBe(false);
  });
});

describe("MCP over the tunnel", () => {
  it("serves tools to an approved client under its own connection", () => {
    const tokens = connect();
    const initialized = json<{ result: { protocolVersion: string; serverInfo: { name: string } } }>(
      rpc(tokens.access_token, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "claude-ai", version: "1" } } }),
    );
    expect(initialized.result).toMatchObject({ protocolVersion: "2025-06-18", serverInfo: { name: "obnixe" } });
    expect(rpc(tokens.access_token, { jsonrpc: "2.0", method: "notifications/initialized" }).status).toBe(202);
    const listed = json<{ result: { tools: { name: string; inputSchema: { type: string } }[] } }>(rpc(tokens.access_token, { jsonrpc: "2.0", id: 2, method: "tools/list" }));
    expect(listed.result.tools.find((tool) => tool.name === "get_history")?.inputSchema.type).toBe("object");
    const called = json<{ result: { content: { text: string }[]; isError: boolean } }>(
      rpc(tokens.access_token, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "list_sports", arguments: {} } }),
    );
    expect(called.result.isError).toBe(false);
    const [connection] = context.db.select().from(agentConnection).all();
    expect(connection).toMatchObject({ client: "Claude", host: "À distance", endedAt: null });
    expect(context.db.select().from(agentCall).all()).toEqual([expect.objectContaining({ connectionId: connection?.id, tool: "list_sports" })]);
  });

  it("refreshes expired access tokens with rotating refresh tokens", () => {
    const tokens = connect();
    context.advance(tokens.expires_in * 1000);
    expect(rpc(tokens.access_token, { jsonrpc: "2.0", id: 1, method: "ping" }).status).toBe(401);
    const refreshed = json<Tokens>(send("POST", "/token", form({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: tokens.clientId })));
    expect(rpc(refreshed.access_token, { jsonrpc: "2.0", id: 1, method: "ping" }).status).toBe(200);
    context.advance(3 * 60_000);
    const replayed = send("POST", "/token", form({ grant_type: "refresh_token", refresh_token: tokens.refresh_token }));
    expect(json<{ error: string }>(replayed).error).toBe("invalid_grant");
  });

  it("keeps grants across restarts and ends them when revoked on the phone", () => {
    const tokens = connect();
    server = createServer();
    expect(rpc(tokens.access_token, { jsonrpc: "2.0", id: 1, method: "ping" }).status).toBe(200);
    const [grant] = server.approved as readonly RemoteGrant[];
    server.revoke(grant?.id ?? "");
    expect(rpc(tokens.access_token, { jsonrpc: "2.0", id: 1, method: "ping" }).status).toBe(401);
    expect(context.db.select().from(agentConnection).get()?.endReason).toBe("user");
    expect(parseRemoteGrants(stored)).toEqual([]);
  });

  it("answers batches and malformed bodies with JSON-RPC errors", () => {
    const tokens = connect();
    const batch = json<{ id: number }[]>(rpc(tokens.access_token, [{ jsonrpc: "2.0", id: 1, method: "ping" }, { jsonrpc: "2.0", id: 2, method: "nope" }]));
    expect(batch.map((reply) => reply.id)).toEqual([1, 2]);
    const broken = send("POST", "/mcp", "{", { authorization: `Bearer ${tokens.access_token}` });
    expect(json<{ error: { code: number } }>(broken).error.code).toBe(-32700);
  });
});

describe("form parsing", () => {
  it("decodes plus signs and percent escapes and skips broken pairs", () => {
    expect([...parseForm("a=1+2&b=%C3%A9&c=%E0%A4%A&a=3")]).toEqual([
      ["a", "1 2"],
      ["b", "é"],
    ]);
  });
});
