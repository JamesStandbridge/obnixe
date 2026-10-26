import { z } from "zod";

export const maxPhoneHosts = 8;

const label = "[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?";
const hostPortPattern = new RegExp(`^${label}(?:\\.${label})*:(\\d{1,5})$`);

function isHostPort(text: string): boolean {
  const match = hostPortPattern.exec(text);
  const port = Number(match?.[1]);
  if (match === null || port < 1 || port > 65_535) return false;
  const name = text.slice(0, text.lastIndexOf(":"));
  if (!/^[\d.]+$/.test(name)) return true;
  const octets = name.split(".");
  return octets.length === 4 && octets.every((octet) => /^(?:0|[1-9]\d{0,2})$/.test(octet) && Number(octet) <= 255);
}

/** One address the phone can dial: a DNS name or an IPv4 address, always with its port. */
export const phoneHostSchema = z.string().max(260).refine(isHostPort, "Expected host:port");

export const phoneHostsSchema = z
  .array(phoneHostSchema)
  .max(maxPhoneHosts)
  .refine((hosts) => new Set(hosts).size === hosts.length, "Duplicate host");
