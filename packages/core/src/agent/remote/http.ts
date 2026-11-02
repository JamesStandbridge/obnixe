/** One HTTP request received through the tunnel; header names are lowercase. */
export interface RemoteRequest {
  readonly method: string;
  readonly target: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

export interface RemoteResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

export interface RequestTarget {
  readonly path: string;
  readonly query: ReadonlyMap<string, string>;
}

function decodeComponent(text: string): string | null {
  try {
    return decodeURIComponent(text.replace(/\+/g, " "));
  } catch (error) {
    if (error instanceof URIError) return null;
    throw error;
  }
}

/** Parses `a=1&b=2` form or query text; the first value of a repeated name wins and undecodable pairs are skipped. */
export function parseForm(text: string): ReadonlyMap<string, string> {
  const values = new Map<string, string>();
  for (const pair of text.split("&")) {
    if (pair === "") continue;
    const separator = pair.indexOf("=");
    const name = decodeComponent(separator === -1 ? pair : pair.slice(0, separator));
    const value = decodeComponent(separator === -1 ? "" : pair.slice(separator + 1));
    if (name !== null && value !== null && !values.has(name)) values.set(name, value);
  }
  return values;
}

export function parseTarget(target: string): RequestTarget {
  const separator = target.indexOf("?");
  const path = separator === -1 ? target : target.slice(0, separator);
  return { path: path.length > 1 ? path.replace(/\/+$/, "") : path, query: parseForm(separator === -1 ? "" : target.slice(separator + 1)) };
}

export function formQuery(values: Readonly<Record<string, string>>): string {
  return Object.entries(values)
    .map(([name, value]) => `${encodeURIComponent(name)}=${encodeURIComponent(value)}`)
    .join("&");
}

const noStore = { "cache-control": "no-store" } as const;

export function jsonResponse(status: number, value: unknown, headers: Readonly<Record<string, string>> = {}): RemoteResponse {
  return { status, headers: { "content-type": "application/json", ...noStore, ...headers }, body: JSON.stringify(value) };
}

export function htmlResponse(status: number, html: string): RemoteResponse {
  return {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'",
      "x-frame-options": "DENY",
      ...noStore,
    },
    body: html,
  };
}

export function emptyResponse(status: number, headers: Readonly<Record<string, string>> = {}): RemoteResponse {
  return { status, headers: { ...noStore, ...headers }, body: "" };
}
