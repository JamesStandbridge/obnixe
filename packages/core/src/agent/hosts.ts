import { z } from "zod";

export const defaultPhonePort = 7429;
export const maxPhoneHosts = 8;

const hostPattern = /^((?:0|[1-9]\d{0,2})\.(?:0|[1-9]\d{0,2})\.(?:0|[1-9]\d{0,2})\.(?:0|[1-9]\d{0,2}))(?::([1-9]\d{0,4}))?$/;

/** True for the IPv4 ranges a phone may be told to dial: RFC 1918, Tailscale 100.64.0.0/10 and loopback 127.0.0.0/8. */
export function isPrivateDialAddress(address: string): boolean {
  const octets = address.split(".").map(Number);
  const [first, second] = octets;
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet > 255) || first === undefined || second === undefined) return false;
  if (first === 10 || first === 127) return true;
  if (first === 172) return second >= 16 && second <= 31;
  if (first === 192) return second === 168;
  return first === 100 && second >= 64 && second <= 127;
}

/** Canonical `address:port` for a private IPv4 literal with an optional canonical port, or null for anything else. */
export function normalizePhoneHost(text: string): string | null {
  const match = hostPattern.exec(text);
  const address = match?.[1];
  if (match === null || address === undefined || !isPrivateDialAddress(address)) return null;
  const port = match[2] === undefined ? defaultPhonePort : Number(match[2]);
  return port > 65_535 ? null : `${address}:${port}`;
}

/** Addresses the phone may dial, normalized to `address:port` and deduplicated; DNS names and public addresses are refused. */
export const phoneHostsSchema = z
  .array(z.string().max(32))
  .max(maxPhoneHosts)
  .transform((hosts, context) => {
    const normalized: string[] = [];
    for (const host of hosts) {
      const canonical = normalizePhoneHost(host);
      if (canonical === null) {
        context.addIssue({ code: "custom", message: `Not a private IPv4 address: ${host}` });
        return z.NEVER;
      }
      if (!normalized.includes(canonical)) normalized.push(canonical);
    }
    return normalized;
  });
