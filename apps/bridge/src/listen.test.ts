import type { NetworkInterfaceInfo } from "node:os";
import { describe, expect, it } from "vitest";
import { PhoneHostError, isPrivateLanAddress, isTailscaleAddress, selectPhoneHosts } from "./listen.ts";
import type { InterfaceTable } from "./listen.ts";

function ipv4(address: string, internal = false): NetworkInterfaceInfo {
  return { address, netmask: "255.255.255.0", family: "IPv4", mac: "00:00:00:00:00:00", internal, cidr: `${address}/24` };
}

function ipv6(address: string): NetworkInterfaceInfo {
  return { address, netmask: "ffff:ffff:ffff:ffff::", family: "IPv6", mac: "00:00:00:00:00:00", internal: false, cidr: `${address}/64`, scopeid: 0 };
}

const laptop: InterfaceTable = {
  lo0: [ipv4("127.0.0.1", true), ipv6("::1")],
  utun4: [ipv6("fd7a:115c:a1e0::1"), ipv4("100.101.12.7")],
  en0: [ipv4("192.168.1.24"), ipv6("fe80::1")],
  en5: [ipv4("10.20.0.3"), ipv4("169.254.12.4")],
  bridge100: [ipv4("172.20.10.2")],
  en7: [ipv4("82.64.12.200")],
};

describe("phone listen hosts", () => {
  it("recognizes the Tailscale range only", () => {
    expect(["100.64.0.1", "100.101.12.7", "100.127.255.254"].every(isTailscaleAddress)).toBe(true);
    expect(["100.63.255.255", "100.128.0.1", "10.0.0.1", "192.168.1.24", "fd7a:115c:a1e0::1", "100.64"].some(isTailscaleAddress)).toBe(false);
  });

  it("recognizes the private LAN ranges only", () => {
    expect(["10.0.0.1", "10.255.255.254", "172.16.0.1", "172.31.255.254", "192.168.0.1"].every(isPrivateLanAddress)).toBe(true);
    expect(["172.15.0.1", "172.32.0.1", "192.169.0.1", "169.254.1.1", "100.101.12.7", "82.64.12.200", "127.0.0.1", "fd00::1"].some(isPrivateLanAddress)).toBe(false);
  });

  it("binds loopback, the LAN and Tailscale, announces the LAN first and never touches public addresses", () => {
    expect(selectPhoneHosts(laptop, undefined)).toEqual({
      bind: ["127.0.0.1", "192.168.1.24", "10.20.0.3", "172.20.10.2", "100.101.12.7"],
      advertise: ["192.168.1.24", "10.20.0.3", "172.20.10.2", "100.101.12.7"],
      source: "interfaces",
    });
  });

  it("falls back to loopback alone without any private address", () => {
    const offline: InterfaceTable = { lo0: laptop.lo0, en7: laptop.en7, utun0: undefined };
    expect(selectPhoneHosts(offline, undefined)).toEqual({ bind: ["127.0.0.1"], advertise: ["127.0.0.1"], source: "interfaces" });
    expect(selectPhoneHosts({ lo0: [ipv4("100.100.100.100", true)] }, "")).toEqual({ bind: ["127.0.0.1"], advertise: ["127.0.0.1"], source: "interfaces" });
  });

  it("honours a valid override and refuses anything else", () => {
    expect(selectPhoneHosts(laptop, "192.168.1.24")).toEqual({ bind: ["192.168.1.24"], advertise: ["192.168.1.24"], source: "override" });
    expect(selectPhoneHosts(laptop, "0.0.0.0")).toEqual({ bind: ["0.0.0.0"], advertise: ["192.168.1.24", "10.20.0.3", "172.20.10.2", "100.101.12.7"], source: "override" });
    expect(selectPhoneHosts({}, "fd7a:115c:a1e0::1")).toEqual({ bind: ["fd7a:115c:a1e0::1"], advertise: [], source: "override" });
    expect(() => selectPhoneHosts(laptop, "my-mac.local")).toThrow(PhoneHostError);
  });
});
