import { defaultPhonePort } from "@obnixe/core";

const hostPattern = /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*(?::\d{1,5})?$/;

export function normalizeHost(input: string): string | null {
  const host = input
    .trim()
    .replace(/^wss?:\/\//i, "")
    .replace(/\/+$/, "")
    .toLowerCase();
  return hostPattern.test(host) ? host : null;
}

export function bridgeUrl(host: string): string {
  return /:\d+$/.test(host) ? `ws://${host}` : `ws://${host}:${defaultPhonePort}`;
}

export function isTailscaleHost(host: string): boolean {
  const name = host.replace(/:\d+$/, "");
  if (name.endsWith(".ts.net")) return true;
  const [first, second] = name.split(".").map(Number);
  return first === 100 && second !== undefined && second >= 64 && second <= 127;
}
