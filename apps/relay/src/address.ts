import type { IncomingMessage } from "node:http";
import { isIP } from "node:net";

function normalize(address: string): string {
  return address.startsWith("::ffff:") ? address.slice("::ffff:".length) : address;
}

/**
 * Address limits are keyed by. With `proxyHops` trusted proxies in front, the client is the entry that many positions
 * from the end of X-Forwarded-For, since each proxy appends the address it received the request from.
 */
export function clientAddress(request: IncomingMessage, proxyHops: number): string {
  const direct = normalize(request.socket.remoteAddress ?? "unknown");
  if (proxyHops === 0) return direct;
  const header = request.headers["x-forwarded-for"];
  if (header === undefined) return direct;
  const entries = (Array.isArray(header) ? header.join(",") : header)
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
  const entry = entries[entries.length - proxyHops];
  return entry !== undefined && isIP(entry) !== 0 ? normalize(entry) : direct;
}
