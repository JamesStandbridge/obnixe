import type { NetworkInterfaceInfo } from "node:os";
import { describe, expect, it } from "vitest";
import { PhoneHostError, isTailscaleAddress, selectPhoneHost } from "./listen.ts";
import type { InterfaceTable } from "./listen.ts";

function ipv4(address: string, internal = false): NetworkInterfaceInfo {
  return { address, netmask: "255.255.255.0", family: "IPv4", mac: "00:00:00:00:00:00", internal, cidr: `${address}/24` };
}

function ipv6(address: string): NetworkInterfaceInfo {
  return { address, netmask: "ffff:ffff:ffff:ffff::", family: "IPv6", mac: "00:00:00:00:00:00", internal: false, cidr: `${address}/64`, scopeid: 0 };
}

const laptop: InterfaceTable = {
  lo0: [ipv4("127.0.0.1", true), ipv6("::1")],
  en0: [ipv4("192.168.1.24"), ipv6("fe80::1")],
  utun4: [ipv6("fd7a:115c:a1e0::1"), ipv4("100.101.12.7")],
};

describe("phone listen host", () => {
  it("recognizes the Tailscale range only", () => {
    expect(["100.64.0.1", "100.101.12.7", "100.127.255.254"].every(isTailscaleAddress)).toBe(true);
    expect(["100.63.255.255", "100.128.0.1", "10.0.0.1", "192.168.1.24", "fd7a:115c:a1e0::1", "100.64"].some(isTailscaleAddress)).toBe(false);
  });

  it("binds the Tailscale IPv4 address when there is one", () => {
    expect(selectPhoneHost(laptop, undefined)).toEqual({ address: "100.101.12.7", source: "tailscale" });
  });

  it("falls back to loopback without Tailscale", () => {
    const offline: InterfaceTable = { lo0: laptop.lo0, en0: laptop.en0, utun0: undefined };
    expect(selectPhoneHost(offline, undefined)).toEqual({ address: "127.0.0.1", source: "loopback" });
    expect(selectPhoneHost({ lo0: [ipv4("100.100.100.100", true)] }, "")).toEqual({ address: "127.0.0.1", source: "loopback" });
  });

  it("honours a valid override and refuses anything else", () => {
    expect(selectPhoneHost(laptop, "0.0.0.0")).toEqual({ address: "0.0.0.0", source: "override" });
    expect(selectPhoneHost({}, "fd7a:115c:a1e0::1")).toEqual({ address: "fd7a:115c:a1e0::1", source: "override" });
    expect(() => selectPhoneHost(laptop, "my-mac.local")).toThrow(PhoneHostError);
  });
});
