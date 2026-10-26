import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { pagePolicy, pairPage } from "./page.ts";
import type { InviteResult, PairResult, PhoneEndpoint } from "./phone.ts";

const maxBody = 1024;

export interface ControlServer {
  readonly port: number;
  readonly close: () => Promise<void>;
}

export interface PairRequest {
  readonly code: string;
}

function isPairRequest(value: unknown): value is PairRequest {
  return typeof value === "object" && value !== null && "code" in value && typeof value.code === "string";
}

function pairStatus(result: PairResult): number {
  switch (result.kind) {
    case "paired":
      return 200;
    case "invalid_code":
      return 400;
    case "bad_code":
      return 401;
    case "no_phone":
      return 404;
    case "failed":
      return 502;
    default: {
      const unreachable: never = result;
      throw new Error(`Unhandled pair result ${JSON.stringify(unreachable)}`);
    }
  }
}

function inviteStatus(result: InviteResult): number {
  switch (result.kind) {
    case "ready":
      return 201;
    case "no_address":
      return 409;
    default: {
      const unreachable: never = result;
      throw new Error(`Unhandled invite result ${JSON.stringify(unreachable)}`);
    }
  }
}

const privateHeaders = { "cache-control": "no-store", "x-content-type-options": "nosniff", "cross-origin-resource-policy": "same-origin" } as const;

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { ...privateHeaders, "content-type": "application/json" }).end(JSON.stringify(body));
}

function servePage(endpoint: PhoneEndpoint, response: ServerResponse): void {
  const result = endpoint.invite();
  switch (result.kind) {
    case "ready": {
      const nonce = randomBytes(16).toString("base64");
      response
        .writeHead(200, { ...privateHeaders, "content-type": "text/html; charset=utf-8", "content-security-policy": pagePolicy(nonce), "x-frame-options": "DENY", "referrer-policy": "no-referrer" })
        .end(pairPage(result.ticket, nonce));
      return;
    }
    case "no_address":
      response.writeHead(409, { ...privateHeaders, "content-type": "text/plain; charset=utf-8" }).end("Ce Mac n'a aucune adresse IPv4 joignable par le téléphone. Retire OBNIXE_PHONE_HOST ou indique une adresse IPv4.");
      return;
    default: {
      const unreachable: never = result;
      throw new Error(`Unhandled invite result ${JSON.stringify(unreachable)}`);
    }
  }
}

function readBody(request: IncomingMessage): Promise<string | null> {
  return new Promise((resolve) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      body += chunk;
      if (body.length > maxBody) {
        resolve(null);
        request.destroy();
      }
    });
    request.on("end", () => resolve(body));
  });
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

/**
 * Localhost-only HTTP port used by `obnixe-bridge pair` and `forget`, and serving the QR page at /pair. Requires a
 * loopback Host against DNS rebinding and a JSON content type on writes so other sites cannot post codes; responses carry
 * no CORS header, so other origins cannot read the invitation.
 */
export async function startControl(endpoint: PhoneEndpoint, port: number): Promise<ControlServer> {
  const server = createServer((request, response) => {
    void handle(endpoint, request, response, server.address() as AddressInfo);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  return {
    port: (server.address() as AddressInfo).port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function handle(endpoint: PhoneEndpoint, request: IncomingMessage, response: ServerResponse, address: AddressInfo): Promise<void> {
  const allowedHosts = new Set([`127.0.0.1:${address.port}`, `localhost:${address.port}`]);
  if (!allowedHosts.has(request.headers.host ?? "")) {
    json(response, 403, { error: "forbidden" });
    return;
  }
  if (request.method === "GET" && request.url === "/status") {
    json(response, 200, endpoint.status());
    return;
  }
  if (request.method === "GET" && request.url === "/pair") {
    servePage(endpoint, response);
    return;
  }
  if (request.method === "GET" && request.url === "/invite") {
    const status = endpoint.inviteStatus();
    json(response, status === null ? 404 : 200, status ?? { error: "no_invite" });
    return;
  }
  if (request.method === "POST" && request.url === "/invite") {
    if (request.headers["content-type"] !== "application/json") {
      json(response, 415, { error: "json_required" });
      return;
    }
    const result = endpoint.renewInvite();
    json(response, inviteStatus(result), result);
    return;
  }
  if (request.method === "POST" && request.url === "/pair") {
    if (request.headers["content-type"] !== "application/json") {
      json(response, 415, { error: "json_required" });
      return;
    }
    const body = await readBody(request);
    const parsed = body === null ? null : parseJson(body);
    if (!isPairRequest(parsed)) {
      json(response, 400, { kind: "invalid_code" });
      return;
    }
    const result = await endpoint.pair(parsed.code);
    json(response, pairStatus(result), result);
    return;
  }
  if (request.method === "POST" && request.url === "/forget") {
    if (request.headers["content-type"] !== "application/json") {
      json(response, 415, { error: "json_required" });
      return;
    }
    json(response, 200, endpoint.forgetAll());
    return;
  }
  json(response, 404, { error: "not_found" });
}
