import { describe, expect, it } from "vitest";
import { limitKey } from "./address.ts";

describe("limit keys", () => {
  it("keeps IPv4 addresses and unwraps IPv4-mapped IPv6", () => {
    expect(limitKey("203.0.113.7")).toBe("203.0.113.7");
    expect(limitKey("::ffff:203.0.113.7")).toBe("203.0.113.7");
  });

  it("groups IPv6 addresses by /64 prefix in every notation", () => {
    const key = "2001:db8:abcd:12::/64";
    expect(limitKey("2001:db8:abcd:12::1")).toBe(key);
    expect(limitKey("2001:0DB8:abcd:0012:ffff:1:2:3")).toBe(key);
    expect(limitKey("2001:db8:abcd:12:0:0:192.0.2.1")).toBe(key);
    expect(limitKey("fe80::1%en0")).toBe("fe80:0:0:0::/64");
    expect(limitKey("::1")).toBe("0:0:0:0::/64");
    expect(limitKey("2001:db8:abcd:13::1")).not.toBe(key);
  });
});
