import { describe, expect, it } from "vitest";
import { bridgeUrl, isTailscaleHost, normalizeHost } from "@/features/agent/host";

describe("normalizeHost", () => {
  it("accepts names, addresses and ports, trimmed and lower-cased", () => {
    expect(normalizeHost("  MacBook-Pro.local ")).toBe("macbook-pro.local");
    expect(normalizeHost("192.168.1.20")).toBe("192.168.1.20");
    expect(normalizeHost("192.168.1.20:8000")).toBe("192.168.1.20:8000");
    expect(normalizeHost("mac.tail1234.ts.net")).toBe("mac.tail1234.ts.net");
  });

  it("drops a ws scheme and trailing slashes", () => {
    expect(normalizeHost("ws://mac.local:7429/")).toBe("mac.local:7429");
    expect(normalizeHost("WSS://Mac.local//")).toBe("mac.local");
  });

  it("refuses anything that is not a host", () => {
    for (const input of ["", "   ", "http://mac.local", "mac.local/path", "-mac.local", "mac-.local", "mac..local", "mac local", "mac.local:123456", "mac.local:", `${"a".repeat(64)}.local`]) {
      expect(normalizeHost(input)).toBeNull();
    }
  });
});

describe("bridgeUrl", () => {
  it("adds the default phone port unless a port is given", () => {
    expect(bridgeUrl("mac.local")).toBe("ws://mac.local:7429");
    expect(bridgeUrl("mac.local:9000")).toBe("ws://mac.local:9000");
  });
});

describe("isTailscaleHost", () => {
  it("recognizes MagicDNS names and the 100.64.0.0/10 range", () => {
    expect(isTailscaleHost("mac.tail1234.ts.net")).toBe(true);
    expect(isTailscaleHost("mac.tail1234.ts.net:7429")).toBe(true);
    expect(isTailscaleHost("100.64.0.1")).toBe(true);
    expect(isTailscaleHost("100.127.255.254:7429")).toBe(true);
  });

  it("rejects other hosts", () => {
    for (const host of ["100.63.0.1", "100.128.0.1", "192.168.1.20", "mac.local", "ts.net.example.com", "100"]) {
      expect(isTailscaleHost(host)).toBe(false);
    }
  });
});
