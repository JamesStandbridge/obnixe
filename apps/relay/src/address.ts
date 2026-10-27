import type { IncomingMessage } from "node:http";
import { isIP, isIPv4, isIPv6 } from "node:net";

function hextets(part: string): string[] {
  if (part === "") return [];
  const groups = part.split(":");
  const last = groups.at(-1) ?? "";
  if (!isIPv4(last)) return groups;
  const [a = 0, b = 0, c = 0, d = 0] = last.split(".").map(Number);
  return [...groups.slice(0, -1), ((a << 8) | b).toString(16), ((c << 8) | d).toString(16)];
}

/** The /64 prefix of an IPv6 address, which one subscriber usually holds whole, so limits cannot be dodged by rotating inside it. */
function ipv6Prefix(address: string): string {
  const [head = "", tail] = address.split("%")[0]?.split("::") ?? [];
  const left = hextets(head);
  const right = tail === undefined ? [] : hextets(tail);
  const groups = [...left, ...Array.from({ length: 8 - left.length - right.length }, () => "0"), ...right];
  return `${groups
    .slice(0, 4)
    .map((group) => Number.parseInt(group, 16).toString(16))
    .join(":")}::/64`;
}

/** Key the per-address limits use: an IPv4 address, or the /64 prefix of an IPv6 one. */
export function limitKey(address: string): string {
  const plain = address.startsWith("::ffff:") && isIPv4(address.slice("::ffff:".length)) ? address.slice("::ffff:".length) : address;
  return isIPv6(plain) ? ipv6Prefix(plain.toLowerCase()) : plain;
}

/**
 * Limit key of the client. With `proxyHops` trusted proxies in front, the client is the entry that many positions from
 * the end of X-Forwarded-For, since each proxy appends the address it received the request from.
 */
export function clientAddress(request: IncomingMessage, proxyHops: number): string {
  const direct = limitKey(request.socket.remoteAddress ?? "unknown");
  if (proxyHops === 0) return direct;
  const header = request.headers["x-forwarded-for"];
  if (header === undefined) return direct;
  const entries = (Array.isArray(header) ? header.join(",") : header)
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
  const entry = entries[entries.length - proxyHops];
  return entry !== undefined && isIP(entry) !== 0 ? limitKey(entry) : direct;
}
