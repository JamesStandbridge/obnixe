import { z } from "zod";
import type { EpochMs } from "@obnixe/schema";
import type { Environment, ObnixeDatabase } from "../../database.ts";
import { clientLabel } from "../clients.ts";
import { closeConnection, isConnectionOpen, openConnection } from "../connection.ts";
import { runAgentTool } from "../dispatch.ts";
import type { RandomBytes } from "../protocol.ts";
import { emptyResponse, htmlResponse, jsonResponse, parseForm, parseTarget } from "./http.ts";
import type { RemoteRequest, RemoteResponse } from "./http.ts";
import { answerMcpBody } from "./mcp.ts";
import {
  accessTokenTtlMs,
  decodeClientId,
  encodeClientId,
  hashToken,
  isAllowedRedirectUri,
  newToken,
  redirectHost,
  refreshGraceMs,
  remoteScope,
  verifiesChallenge,
  withQuery,
} from "./oauth.ts";
import type { RemoteGrant } from "./oauth.ts";
import { authorizationPage, errorPage, landingPage } from "./page.ts";

/** Host label of the connections opened by remote agents. */
export const remoteConnectionHost = "À distance";

const authorizationTtlMs = 10 * 60_000;
const codeTtlMs = 5 * 60_000;
const maxPendingAuthorizations = 5;
const maxRedirectUris = 5;

/** Where the server keeps what must survive the app: the key signing client ids, and the approved grants. */
export interface RemoteVault {
  readonly key: Uint8Array;
  readonly loadGrants: () => readonly RemoteGrant[];
  readonly saveGrants: (grants: readonly RemoteGrant[]) => void;
}

/** An authorization waiting for the user on the phone. */
export interface PendingAuthorization {
  readonly id: string;
  readonly client: string;
  readonly host: string;
  readonly createdAt: EpochMs;
}

interface AuthorizationRequest extends PendingAuthorization {
  readonly clientId: string;
  readonly redirectUri: string;
  readonly challenge: string;
  readonly state: string | null;
  location: string | null;
}

interface AuthorizationCode {
  readonly clientId: string;
  readonly client: string;
  readonly redirectUri: string;
  readonly challenge: string;
  readonly expiresAt: EpochMs;
}

export interface RemoteServerListener {
  readonly onAuthorizations: (pending: readonly PendingAuthorization[]) => void;
  readonly onGrants: (grants: readonly RemoteGrant[]) => void;
}

export interface RemoteServerOptions {
  readonly db: ObnixeDatabase;
  readonly env: Environment;
  readonly vault: RemoteVault;
  readonly randomBytes: RandomBytes;
  readonly timeZone: () => string;
  readonly listener: RemoteServerListener;
}

const registrationSchema = z.object({
  redirect_uris: z.array(z.string()).min(1).max(maxRedirectUris),
  client_name: z.string().optional(),
});

const corsHeaders = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "authorization, content-type, mcp-protocol-version, mcp-session-id",
  "access-control-expose-headers": "www-authenticate, mcp-session-id",
} as const;

function api(response: RemoteResponse): RemoteResponse {
  return { ...response, headers: { ...response.headers, ...corsHeaders } };
}

function oauthError(status: number, error: string, description: string): RemoteResponse {
  return api(jsonResponse(status, { error, error_description: description }));
}

function methodNotAllowed(allow: string): RemoteResponse {
  return api(emptyResponse(405, { allow }));
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

function formBody(request: RemoteRequest): ReadonlyMap<string, string> {
  if (!(request.headers["content-type"] ?? "").includes("application/json")) return parseForm(request.body);
  const parsed = z.record(z.string(), z.string()).safeParse(parseJson(request.body));
  return new Map(parsed.success ? Object.entries(parsed.data) : []);
}

/**
 * The phone's own OAuth 2.1 authorization server and MCP Streamable HTTP endpoint, answering the requests the tunnel
 * receives. Clients register dynamically, the user approves each authorization on the phone, and every approved grant
 * owns one agent connection that journals its tool calls until the grant is revoked.
 */
export class RemoteServer {
  private readonly options: RemoteServerOptions;
  private baseUrl: string | null = null;
  private grants: readonly RemoteGrant[];
  private readonly requests = new Map<string, AuthorizationRequest>();
  private readonly codes = new Map<string, AuthorizationCode>();

  constructor(options: RemoteServerOptions) {
    this.options = options;
    this.grants = options.vault.loadGrants();
  }

  /** The public URL the tunnel serves, without a trailing slash; requests are refused while it is unknown. */
  setBaseUrl(url: string | null): void {
    this.baseUrl = url === null ? null : url.replace(/\/+$/, "");
  }

  get pending(): readonly PendingAuthorization[] {
    const now = this.options.env.now();
    return [...this.requests.values()]
      .filter((request) => request.location === null && now - request.createdAt < authorizationTtlMs)
      .map(({ id, client, host, createdAt }) => ({ id, client, host, createdAt }));
  }

  get approved(): readonly RemoteGrant[] {
    return this.grants;
  }

  handle(request: RemoteRequest): RemoteResponse {
    const base = this.baseUrl;
    if (base === null) return emptyResponse(503);
    this.expire();
    const { path, query } = parseTarget(request.target);
    const method = request.method.toUpperCase();
    if (method === "OPTIONS") return api(emptyResponse(204));
    switch (path) {
      case "/":
        return method === "GET" ? htmlResponse(200, landingPage()) : methodNotAllowed("GET");
      case "/.well-known/oauth-protected-resource":
      case "/.well-known/oauth-protected-resource/mcp":
        return method === "GET" ? api(jsonResponse(200, this.resourceMetadata(base))) : methodNotAllowed("GET");
      case "/.well-known/oauth-authorization-server":
        return method === "GET" ? api(jsonResponse(200, this.serverMetadata(base))) : methodNotAllowed("GET");
      case "/register":
        return method === "POST" ? this.register(request) : methodNotAllowed("POST");
      case "/authorize":
        return method === "GET" ? this.authorize(query) : methodNotAllowed("GET");
      case "/authorize/status":
        return method === "GET" ? this.authorizationStatus(query) : methodNotAllowed("GET");
      case "/token":
        return method === "POST" ? this.token(request) : methodNotAllowed("POST");
      case "/revoke":
        return method === "POST" ? this.revokeToken(request) : methodNotAllowed("POST");
      case "/mcp":
        return method === "POST" ? this.mcp(request, base) : methodNotAllowed("POST");
      default:
        return api(jsonResponse(404, { error: "not_found" }));
    }
  }

  /** Records the user's answer; the waiting browser page then follows the redirect back to the client. */
  decide(id: string, approved: boolean): void {
    const request = this.requests.get(id);
    const base = this.baseUrl;
    if (request === undefined || request.location !== null || base === null) return;
    const state: Record<string, string> = request.state === null ? {} : { state: request.state };
    if (approved) {
      const code = newToken(this.options.randomBytes);
      this.codes.set(code, {
        clientId: request.clientId,
        client: request.client,
        redirectUri: request.redirectUri,
        challenge: request.challenge,
        expiresAt: (this.options.env.now() + codeTtlMs) as EpochMs,
      });
      request.location = withQuery(request.redirectUri, { code, ...state, iss: base });
    } else {
      request.location = withQuery(request.redirectUri, { error: "access_denied", ...state, iss: base });
    }
    this.options.listener.onAuthorizations(this.pending);
  }

  /** Ends a grant from the phone: its tokens stop working and its connection closes. */
  revoke(grantId: string): void {
    const grant = this.grants.find((candidate) => candidate.id === grantId);
    if (grant !== undefined) this.drop(grant);
  }

  private resourceMetadata(base: string): Readonly<Record<string, unknown>> {
    return { resource: `${base}/mcp`, authorization_servers: [base], scopes_supported: [remoteScope], bearer_methods_supported: ["header"], resource_name: "Obnixe" };
  }

  private serverMetadata(base: string): Readonly<Record<string, unknown>> {
    return {
      issuer: base,
      authorization_endpoint: `${base}/authorize`,
      token_endpoint: `${base}/token`,
      registration_endpoint: `${base}/register`,
      revocation_endpoint: `${base}/revoke`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      revocation_endpoint_auth_methods_supported: ["none"],
      scopes_supported: [remoteScope],
      authorization_response_iss_parameter_supported: true,
    };
  }

  private expire(): void {
    const now = this.options.env.now();
    let changed = false;
    for (const [id, request] of this.requests) {
      if (now - request.createdAt < authorizationTtlMs) continue;
      this.requests.delete(id);
      changed ||= request.location === null;
    }
    for (const [code, entry] of this.codes) if (entry.expiresAt <= now) this.codes.delete(code);
    if (changed) this.options.listener.onAuthorizations(this.pending);
  }

  private register(request: RemoteRequest): RemoteResponse {
    const parsed = registrationSchema.safeParse(parseJson(request.body));
    if (!parsed.success) return oauthError(400, "invalid_client_metadata", "redirect_uris must list 1 to 5 URIs");
    const redirectUris = parsed.data.redirect_uris;
    if (!redirectUris.every(isAllowedRedirectUri)) return oauthError(400, "invalid_redirect_uri", "Redirect URIs must use HTTPS, or HTTP to a loopback address");
    const name = clientLabel(parsed.data.client_name);
    const clientId = encodeClientId(this.options.vault.key, { name, redirectUris });
    return api(
      jsonResponse(201, {
        client_id: clientId,
        client_id_issued_at: Math.floor(this.options.env.now() / 1000),
        client_name: name,
        redirect_uris: redirectUris,
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      }),
    );
  }

  private authorize(query: ReadonlyMap<string, string>): RemoteResponse {
    const clientId = query.get("client_id") ?? "";
    const client = decodeClientId(this.options.vault.key, clientId);
    if (client === null) return htmlResponse(400, errorPage("Cet agent n'est pas enregistré auprès de ce téléphone. Relance la connexion depuis l'agent."));
    const requested = query.get("redirect_uri");
    const redirectUri = requested ?? (client.redirectUris.length === 1 ? client.redirectUris[0] : undefined);
    if (redirectUri === undefined || !client.redirectUris.includes(redirectUri)) return htmlResponse(400, errorPage("L'adresse de retour ne correspond pas à l'agent enregistré."));
    const state = query.get("state") ?? null;
    const stateParam: Record<string, string> = state === null ? {} : { state };
    const fail = (error: string, description: string): RemoteResponse =>
      emptyResponse(302, { location: withQuery(redirectUri, { error, error_description: description, ...stateParam }) });
    if (query.get("response_type") !== "code") return fail("unsupported_response_type", "Only the code flow is supported");
    const challenge = query.get("code_challenge");
    if (challenge === undefined || query.get("code_challenge_method") !== "S256") return fail("invalid_request", "PKCE with S256 is required");
    const id = newToken(this.options.randomBytes);
    const host = redirectHost(redirectUri);
    this.requests.set(id, { id, client: client.name, host, createdAt: this.options.env.now(), clientId, redirectUri, challenge, state, location: null });
    const waiting = [...this.requests.values()].filter((candidate) => candidate.location === null);
    for (const stale of waiting.slice(0, Math.max(0, waiting.length - maxPendingAuthorizations))) this.requests.delete(stale.id);
    this.options.listener.onAuthorizations(this.pending);
    return htmlResponse(200, authorizationPage(id, client.name, host));
  }

  private authorizationStatus(query: ReadonlyMap<string, string>): RemoteResponse {
    const request = this.requests.get(query.get("request") ?? "");
    if (request === undefined) return jsonResponse(200, { status: "expired" });
    if (request.location === null) return jsonResponse(200, { status: "pending" });
    return jsonResponse(200, { status: "done", location: request.location });
  }

  private token(request: RemoteRequest): RemoteResponse {
    const form = formBody(request);
    const grantType = form.get("grant_type");
    switch (grantType) {
      case "authorization_code":
        return this.exchangeCode(form);
      case "refresh_token":
        return this.refresh(form);
      default:
        return oauthError(400, "unsupported_grant_type", "Use authorization_code or refresh_token");
    }
  }

  private exchangeCode(form: ReadonlyMap<string, string>): RemoteResponse {
    const code = form.get("code") ?? "";
    const entry = this.codes.get(code);
    this.codes.delete(code);
    const { env, db } = this.options;
    if (entry === undefined || entry.expiresAt <= env.now()) return oauthError(400, "invalid_grant", "Unknown or expired authorization code");
    const clientId = form.get("client_id");
    const redirectUri = form.get("redirect_uri");
    if ((clientId !== undefined && clientId !== entry.clientId) || (redirectUri !== undefined && redirectUri !== entry.redirectUri)) {
      return oauthError(400, "invalid_grant", "The code was issued to another client or redirect URI");
    }
    if (!verifiesChallenge(form.get("code_verifier") ?? "", entry.challenge)) return oauthError(400, "invalid_grant", "The code verifier does not match the challenge");
    const connectionId = openConnection(db, env, { client: entry.client, host: remoteConnectionHost });
    const access = newToken(this.options.randomBytes);
    const refresh = newToken(this.options.randomBytes);
    const now = env.now();
    const grant: RemoteGrant = {
      id: newToken(this.options.randomBytes),
      clientId: entry.clientId,
      client: entry.client,
      connectionId,
      accessHash: hashToken(access),
      accessExpiresAt: (now + accessTokenTtlMs) as EpochMs,
      refreshHash: hashToken(refresh),
      previousRefreshHash: null,
      rotatedAt: now,
      createdAt: now,
    };
    this.store([...this.grants, grant]);
    return this.tokens(access, refresh);
  }

  private refresh(form: ReadonlyMap<string, string>): RemoteResponse {
    const hash = hashToken(form.get("refresh_token") ?? "");
    const now = this.options.env.now();
    const grant = this.grants.find((candidate) => candidate.refreshHash === hash || (candidate.previousRefreshHash === hash && now - candidate.rotatedAt < refreshGraceMs));
    const clientId = form.get("client_id");
    if (grant === undefined || (clientId !== undefined && clientId !== grant.clientId)) return oauthError(400, "invalid_grant", "Unknown or revoked refresh token");
    if (!isConnectionOpen(this.options.db, grant.connectionId)) {
      this.drop(grant);
      return oauthError(400, "invalid_grant", "This access was revoked on the phone");
    }
    const access = newToken(this.options.randomBytes);
    const refresh = newToken(this.options.randomBytes);
    const rotated: RemoteGrant = {
      ...grant,
      accessHash: hashToken(access),
      accessExpiresAt: (now + accessTokenTtlMs) as EpochMs,
      refreshHash: hashToken(refresh),
      previousRefreshHash: grant.refreshHash,
      rotatedAt: now,
    };
    this.store(this.grants.map((candidate) => (candidate.id === grant.id ? rotated : candidate)));
    return this.tokens(access, refresh);
  }

  private tokens(access: string, refresh: string): RemoteResponse {
    return api(jsonResponse(200, { access_token: access, token_type: "Bearer", expires_in: accessTokenTtlMs / 1000, refresh_token: refresh, scope: remoteScope }));
  }

  private revokeToken(request: RemoteRequest): RemoteResponse {
    const hash = hashToken(formBody(request).get("token") ?? "");
    const grant = this.grants.find((candidate) => candidate.accessHash === hash || candidate.refreshHash === hash);
    if (grant !== undefined) this.drop(grant);
    return api(emptyResponse(200));
  }

  private mcp(request: RemoteRequest, base: string): RemoteResponse {
    const match = /^Bearer\s+(\S+)$/i.exec(request.headers.authorization ?? "");
    const challenge = `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp", scope="${remoteScope}"`;
    if (match === null) return api(jsonResponse(401, { error: "unauthorized" }, { "www-authenticate": challenge }));
    const hash = hashToken(match[1] ?? "");
    const now = this.options.env.now();
    const grant = this.grants.find((candidate) => candidate.accessHash === hash);
    const { db, env } = this.options;
    if (grant === undefined || grant.accessExpiresAt <= now || !isConnectionOpen(db, grant.connectionId)) {
      return api(jsonResponse(401, { error: "invalid_token" }, { "www-authenticate": `${challenge}, error="invalid_token"` }));
    }
    const answer = answerMcpBody(request.body, (tool, args) => runAgentTool(db, env, { connectionId: grant.connectionId, tool, arguments: args, timeZone: this.options.timeZone() }));
    switch (answer.kind) {
      case "accepted":
        return api(emptyResponse(202));
      case "replies":
        return api(jsonResponse(200, answer.replies));
      default: {
        const unreachable: never = answer;
        throw new Error(`Unhandled MCP answer ${JSON.stringify(unreachable)}`);
      }
    }
  }

  private drop(grant: RemoteGrant): void {
    closeConnection(this.options.db, this.options.env, grant.connectionId, "user");
    this.store(this.grants.filter((candidate) => candidate.id !== grant.id));
  }

  private store(grants: readonly RemoteGrant[]): void {
    this.grants = grants;
    this.options.vault.saveGrants(grants);
    this.options.listener.onGrants(grants);
  }
}
