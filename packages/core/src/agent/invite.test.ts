import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { Base64Error, fromBase64Url, toBase64, toBase64Url } from "./encoding.ts";
import { InviteError, formatInvite, parseInvite, pairingTokenBytes } from "./invite.ts";
import type { InviteErrorReason, PairingInvite } from "./invite.ts";

const bytes = (length: number): Uint8Array => new Uint8Array(randomBytes(length));

const invite: PairingInvite = {
  bridgeId: toBase64(bytes(16)),
  token: bytes(pairingTokenBytes),
  name: "MacBook Pro de James",
  hosts: ["192.168.1.24:7429", "10.0.0.5:7429", "100.101.12.7:7429"],
  relay: null,
};

function reasonOf(text: string): InviteErrorReason | null {
  try {
    parseInvite(text);
    return null;
  } catch (error) {
    if (error instanceof InviteError) return error.reason;
    throw error;
  }
}

function withParameter(url: string, key: string, value: string | null): string {
  const [prefix = "", query = ""] = url.split("?");
  const kept = query.split("&").filter((part) => !part.startsWith(`${key}=`));
  return `${prefix}?${[...kept, ...(value === null ? [] : [`${key}=${value}`])].join("&")}`;
}

describe("base64url", () => {
  it("round-trips and refuses padding, standard characters and non-canonical tails", () => {
    for (let length = 0; length < 40; length += 1) {
      const input = bytes(length);
      expect(toBase64Url(input)).toBe(Buffer.from(input).toString("base64url"));
      expect(fromBase64Url(toBase64Url(input))).toEqual(input);
    }
    for (const bad of ["AA==", "A+/B", "A", "AB", "AAB"]) expect(() => fromBase64Url(bad), bad).toThrow(Base64Error);
    expect(fromBase64Url("AA")).toEqual(new Uint8Array([0]));
  });
});

describe("pairing invite", () => {
  it("formats the shared URL and parses it back", () => {
    const url = formatInvite(invite);
    expect(url).toBe(
      `obnixe://pair?v=1&b=${toBase64Url(Buffer.from(invite.bridgeId, "base64"))}&t=${toBase64Url(invite.token)}&n=MacBook%20Pro%20de%20James&h=192.168.1.24:7429,10.0.0.5:7429,100.101.12.7:7429`,
    );
    expect(parseInvite(url)).toEqual(invite);
    expect(parseInvite(` ${url.replace("%20", "+")}\n`)).toEqual(invite);
  });

  it("carries the relay rendezvous through when present", () => {
    const room = toBase64Url(bytes(16));
    const relayed: PairingInvite = { ...invite, relay: { url: "wss://relay.obnixe.app/v1", room } };
    const url = formatInvite(relayed);
    expect(url).toContain(`&r=wss%3A%2F%2Frelay.obnixe.app%2Fv1&room=${room}`);
    expect(parseInvite(url)).toEqual(relayed);
    expect(reasonOf(withParameter(url, "room", null))).toBe("format");
    expect(reasonOf(withParameter(formatInvite(invite), "r", "wss%3A%2F%2Frelay.obnixe.app"))).toBe("format");
    expect(reasonOf(withParameter(url, "r", "ws%3A%2F%2Frelay.obnixe.app"))).toBe("format");
    expect(reasonOf(withParameter(url, "r", "https%3A%2F%2Frelay.obnixe.app"))).toBe("format");
  });

  it("refuses tampered invites", () => {
    const url = formatInvite(invite);
    const token = toBase64Url(invite.token);
    const tampered = [
      url.replace("obnixe://pair", "obnixe://join"),
      url.replace("obnixe://", "https://"),
      url.replace(token, token.slice(0, -2)),
      url.replace(token, `${token}AA`),
      url.replace(token, `${token.slice(0, -1)}=`),
      url.replace(token, token.replace(/^./, "+")),
      withParameter(url, "b", toBase64Url(bytes(15))),
      withParameter(url, "t", null),
      withParameter(url, "n", ""),
      withParameter(url, "n", "%E0%A4%A"),
      withParameter(url, "n", "x".repeat(65)),
      withParameter(url, "h", ""),
      withParameter(url, "h", "192.168.1.24"),
      withParameter(url, "h", "192.168.1.24:0"),
      withParameter(url, "h", "192.168.1.256:7429"),
      withParameter(url, "h", "192.168.1.24:7429,192.168.1.24:7429"),
      withParameter(url, "h", "[fd7a::1]:7429"),
      withParameter(url, "h", Array.from({ length: 9 }, (_, index) => `10.0.0.${index + 1}:7429`).join(",")),
      `${url}&x=1`,
      `${url}&t=${token}`,
      `${url}&`,
      `${url}#fragment`,
    ];
    for (const text of tampered) expect(reasonOf(text), text).toBe("format");
  });

  it("tells a newer invite version apart from garbage", () => {
    const url = formatInvite(invite);
    expect(reasonOf(url.replace("v=1", "v=2"))).toBe("version");
    expect(reasonOf(url.replace("v=1", "v=one"))).toBe("format");
    expect(reasonOf(withParameter(url, "v", null))).toBe("format");
  });
});
