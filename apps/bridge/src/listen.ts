import { isIPv4, isIP } from "node:net";
import type { NetworkInterfaceInfo } from "node:os";

export type InterfaceTable = NodeJS.Dict<NetworkInterfaceInfo[]>;

export type PhoneHostSource = "override" | "interfaces";

/** Where the phone listener binds, and the IPv4 addresses announced to the phone, LAN first then Tailscale. */
export interface PhoneHosts {
  readonly bind: readonly string[];
  readonly advertise: readonly string[];
  readonly source: PhoneHostSource;
}

export const loopbackHost = "127.0.0.1";

export class PhoneHostError extends Error {}

function octets(address: string): readonly number[] {
  return address.split(".").map(Number);
}

/** True for addresses in the Tailscale CGNAT range 100.64.0.0/10. */
export function isTailscaleAddress(address: string): boolean {
  if (!isIPv4(address)) return false;
  const [first, second] = octets(address);
  return first === 100 && second !== undefined && second >= 64 && second <= 127;
}

/** True for the RFC 1918 private ranges 10.0.0.0/8, 172.16.0.0/12 and 192.168.0.0/16. */
export function isPrivateLanAddress(address: string): boolean {
  if (!isIPv4(address)) return false;
  const [first, second] = octets(address);
  if (first === 10) return true;
  if (first === 172) return second !== undefined && second >= 16 && second <= 31;
  return first === 192 && second === 168;
}

function external(interfaces: InterfaceTable, accept: (address: string) => boolean): readonly string[] {
  const found: string[] = [];
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.family === "IPv4" && !entry.internal && accept(entry.address) && !found.includes(entry.address)) found.push(entry.address);
    }
  }
  return found;
}

function scannedAdvertise(interfaces: InterfaceTable): readonly string[] {
  return [...external(interfaces, isPrivateLanAddress), ...external(interfaces, isTailscaleAddress)];
}

/**
 * By default the listener binds loopback, every private LAN IPv4 address and every Tailscale address, never a public one.
 * The override binds a single address; a wildcard override still announces the scanned addresses.
 */
export function selectPhoneHosts(interfaces: InterfaceTable, override: string | undefined): PhoneHosts {
  if (override !== undefined && override !== "") {
    if (isIP(override) === 0) throw new PhoneHostError(`OBNIXE_PHONE_HOST must be an IP address, got ${override}`);
    const wildcard = override === "0.0.0.0" || override === "::";
    return { bind: [override], advertise: wildcard ? scannedAdvertise(interfaces) : isIPv4(override) ? [override] : [], source: "override" };
  }
  const advertise = scannedAdvertise(interfaces);
  return { bind: [loopbackHost, ...advertise], advertise: advertise.length === 0 ? [loopbackHost] : advertise, source: "interfaces" };
}
