import { DurableObject } from "cloudflare:workers";
import {
  encodeRemoteNonce,
  parsePhoneFrame,
  parseRemotePublicKey,
  parseRemoteSignature,
  remoteAnswerTimeoutMs,
  remoteBodyLimit,
  remoteChallengeMessage,
  remoteNonceBytes,
  remotePhoneId,
  remoteRelayHost,
} from "@obnixe/core/agent/remote-relay";
import type { PhoneFrame, RelayFrame } from "@obnixe/core/agent/remote-relay";
import type { Env } from "./env.ts";
import { plainResponse } from "./responses.ts";

const proofTimeoutMs = 10_000;
const maxUnprovenSockets = 4;
const burstRequests = 60;
const requestsPerSecond = 2;
const droppedRequestHeaders = new Set(["cookie", "content-length", "connection", "upgrade"]);
const droppedResponseHeaders = new Set(["content-length", "transfer-encoding", "connection", "set-cookie"]);
const bodilessStatuses = new Set([101, 204, 205, 304]);

const offlineText = "Obnixe n'est pas joignable : ouvre l'application sur ton téléphone et vérifie que l'accès à distance est activé.";

interface Attachment {
  readonly key: string;
  readonly id: string;
  readonly nonce: string;
  readonly proven: boolean;
  readonly openedAt: number;
}

interface Waiting {
  readonly socket: WebSocket;
  readonly method: string;
  readonly resolve: (response: Response) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

function isAttachment(value: unknown): value is Attachment {
  return typeof value === "object" && value !== null && "proven" in value && "nonce" in value && "key" in value;
}

function attachment(socket: WebSocket): Attachment | null {
  const value: unknown = socket.deserializeAttachment();
  return isAttachment(value) ? value : null;
}

function send(socket: WebSocket, frame: RelayFrame): void {
  socket.send(JSON.stringify(frame));
}

async function verifiesProof(proof: Attachment, signatureText: string): Promise<boolean> {
  const key = parseRemotePublicKey(proof.key);
  const signature = parseRemoteSignature(signatureText);
  if (key === null || signature === null) return false;
  const publicKey = await crypto.subtle.importKey("raw", key, { name: "Ed25519" }, false, ["verify"]);
  return crypto.subtle.verify({ name: "Ed25519" }, publicKey, signature, remoteChallengeMessage(proof.id, proof.nonce));
}

function phoneResponse(frame: Extract<PhoneFrame, { type: "response" }>, method: string): Response {
  const headers = new Headers();
  for (const [name, value] of Object.entries(frame.headers)) if (!droppedResponseHeaders.has(name.toLowerCase())) headers.set(name, value);
  const bodiless = bodilessStatuses.has(frame.status) || method === "HEAD";
  return new Response(bodiless ? null : frame.body, { status: frame.status === 101 ? 502 : frame.status, headers });
}

/**
 * One phone's presence on the relay. The phone keeps a hibernatable WebSocket open after proving it holds the key its
 * id derives from; agent requests to the phone's subdomain then travel to it as frames and its answers come back.
 * Nothing is stored: requests only live in memory while the phone answers them.
 */
export class PhoneLink extends DurableObject<Env> {
  private readonly waiting = new Map<number, Waiting>();
  private nextRequest = 0;
  private tokens = burstRequests;
  private refilledAt = Date.now();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    return url.hostname === remoteRelayHost ? this.acceptPhone(url) : this.forward(request, url);
  }

  override async alarm(): Promise<void> {
    const now = Date.now();
    for (const socket of this.ctx.getWebSockets()) {
      const proof = attachment(socket);
      if (proof !== null && !proof.proven && now - proof.openedAt >= proofTimeoutMs) socket.close(4401, "No proof of the phone key");
    }
  }

  override async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const frame = typeof message === "string" ? parsePhoneFrame(message) : null;
    const proof = attachment(socket);
    if (frame === null || proof === null) {
      socket.close(1008, "Malformed frame");
      return;
    }
    switch (frame.type) {
      case "proof":
        await this.prove(socket, proof, frame.signature);
        return;
      case "response":
        if (proof.proven) this.answer(socket, frame);
        return;
      default: {
        const unreachable: never = frame;
        throw new Error(`Unhandled phone frame ${JSON.stringify(unreachable)}`);
      }
    }
  }

  override async webSocketClose(socket: WebSocket): Promise<void> {
    this.abandon(socket);
  }

  override async webSocketError(socket: WebSocket): Promise<void> {
    this.abandon(socket);
  }

  private acceptPhone(url: URL): Response {
    const key = parseRemotePublicKey(url.searchParams.get("key") ?? "");
    if (key === null) return plainResponse(400, "Expected the phone's public key");
    const unproven = this.ctx.getWebSockets().filter((socket) => attachment(socket)?.proven === false);
    for (const stale of unproven.slice(0, Math.max(0, unproven.length - maxUnprovenSockets + 1))) stale.close(4429, "Too many pending connections");
    const [client, server] = Object.values(new WebSocketPair()) as [WebSocket, WebSocket];
    const nonce = encodeRemoteNonce(crypto.getRandomValues(new Uint8Array(remoteNonceBytes)));
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ key: url.searchParams.get("key") ?? "", id: remotePhoneId(key), nonce, proven: false, openedAt: Date.now() } satisfies Attachment);
    send(server, { type: "challenge", nonce });
    void this.ctx.storage.setAlarm(Date.now() + proofTimeoutMs);
    return new Response(null, { status: 101, webSocket: client });
  }

  private async prove(socket: WebSocket, proof: Attachment, signature: string): Promise<void> {
    if (proof.proven) return;
    if (!(await verifiesProof(proof, signature))) {
      socket.close(4403, "Invalid proof of the phone key");
      return;
    }
    for (const other of this.ctx.getWebSockets()) if (other !== socket) other.close(4409, "Replaced by a newer connection");
    socket.serializeAttachment({ ...proof, proven: true } satisfies Attachment);
    send(socket, { type: "online" });
  }

  private phone(): WebSocket | null {
    return this.ctx.getWebSockets().find((socket) => socket.readyState === WebSocket.OPEN && attachment(socket)?.proven === true) ?? null;
  }

  private take(): boolean {
    const now = Date.now();
    this.tokens = Math.min(burstRequests, this.tokens + ((now - this.refilledAt) / 1000) * requestsPerSecond);
    this.refilledAt = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }

  private async forward(request: Request, url: URL): Promise<Response> {
    const socket = this.phone();
    if (socket === null) return plainResponse(503, offlineText, { "retry-after": "30" });
    if (!this.take()) return plainResponse(429, "Trop de requêtes vers ce téléphone, réessaie dans quelques secondes.", { "retry-after": "10" });
    if (Number(request.headers.get("content-length") ?? "0") > remoteBodyLimit) return plainResponse(413, "Request body too large");
    const body = await request.text();
    if (body.length > remoteBodyLimit) return plainResponse(413, "Request body too large");
    const headers: Record<string, string> = {};
    request.headers.forEach((value, name) => {
      if (!droppedRequestHeaders.has(name)) headers[name] = value;
    });
    const id = this.nextRequest;
    this.nextRequest += 1;
    const method = request.method.toUpperCase();
    return new Promise<Response>((resolve) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        resolve(plainResponse(504, "Le téléphone n'a pas répondu à temps : ouvre Obnixe sur ton téléphone."));
      }, remoteAnswerTimeoutMs);
      this.waiting.set(id, { socket, method, timer, resolve });
      send(socket, { type: "request", id, method, target: `${url.pathname}${url.search}`, headers, body });
    });
  }

  private answer(socket: WebSocket, frame: Extract<PhoneFrame, { type: "response" }>): void {
    const entry = this.waiting.get(frame.id);
    if (entry === undefined || entry.socket !== socket) return;
    clearTimeout(entry.timer);
    this.waiting.delete(frame.id);
    entry.resolve(phoneResponse(frame, entry.method));
  }

  private abandon(socket: WebSocket): void {
    for (const [id, entry] of this.waiting) {
      if (entry.socket !== socket) continue;
      clearTimeout(entry.timer);
      this.waiting.delete(id);
      entry.resolve(plainResponse(502, offlineText));
    }
  }
}
