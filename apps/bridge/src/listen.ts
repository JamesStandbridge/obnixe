import { isIPv4, isIP } from "node:net";
import type { NetworkInterfaceInfo } from "node:os";

export type InterfaceTable = NodeJS.Dict<NetworkInterfaceInfo[]>;

export type PhoneHostSource = "override" | "tailscale" | "loopback";

export interface PhoneHost {
  readonly address: string;
  readonly source: PhoneHostSource;
}

export const loopbackHost = "127.0.0.1";

export class PhoneHostError extends Error {}

/** True for addresses in the Tailscale CGNAT range 100.64.0.0/10. */
export function isTailscaleAddress(address: string): boolean {
  if (!isIPv4(address)) return false;
  const [first, second] = address.split(".").map(Number);
  return first === 100 && second !== undefined && second >= 64 && second <= 127;
}

/** Picks the address the phone listener binds: the override when set, else the first Tailscale IPv4 address, else loopback. */
export function selectPhoneHost(interfaces: InterfaceTable, override: string | undefined): PhoneHost {
  if (override !== undefined && override !== "") {
    if (isIP(override) === 0) throw new PhoneHostError(`OBNIXE_PHONE_HOST must be an IP address, got ${override}`);
    return { address: override, source: "override" };
  }
  for (const entries of Object.values(interfaces)) {
    const match = entries?.find((entry) => entry.family === "IPv4" && !entry.internal && isTailscaleAddress(entry.address));
    if (match !== undefined) return { address: match.address, source: "tailscale" };
  }
  return { address: loopbackHost, source: "loopback" };
}
