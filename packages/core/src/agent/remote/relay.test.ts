import { ed25519 } from "@noble/curves/ed25519.js";
import { describe, expect, it } from "vitest";
import { fromBase64Url, toBase64Url } from "../encoding.ts";
import {
  parsePhoneFrame,
  parseRelayFrame,
  parseRemotePublicKey,
  remoteChallengeMessage,
  remoteConnectUrl,
  remoteIdentity,
  remotePhoneIdPattern,
  remotePhoneOrigin,
  signRemoteChallenge,
} from "./relay.ts";

const identity = remoteIdentity(new Uint8Array(32).fill(3));

describe("phone identity", () => {
  it("derives a stable DNS label from the public key", () => {
    expect(identity.id).toMatch(remotePhoneIdPattern);
    expect(remoteIdentity(new Uint8Array(32).fill(3)).id).toBe(identity.id);
    expect(remoteIdentity(new Uint8Array(32).fill(4)).id).not.toBe(identity.id);
    expect(remotePhoneOrigin(identity.id)).toBe(`https://${identity.id}.obnixe.app`);
  });

  it("connects with its public key, which the relay decodes back", () => {
    const key = new URL(remoteConnectUrl(identity.publicKey)).searchParams.get("key") ?? "";
    expect(parseRemotePublicKey(key)).toEqual(identity.publicKey);
    expect(parseRemotePublicKey("not base64!")).toBeNull();
    expect(parseRemotePublicKey(toBase64Url(new Uint8Array(31)))).toBeNull();
  });

  it("signs challenges bound to its id", () => {
    const signature = fromBase64Url(signRemoteChallenge(identity, "nonce"));
    expect(ed25519.verify(signature, remoteChallengeMessage(identity.id, "nonce"), identity.publicKey)).toBe(true);
    expect(ed25519.verify(signature, remoteChallengeMessage(identity.id, "other"), identity.publicKey)).toBe(false);
    expect(ed25519.verify(signature, remoteChallengeMessage("a".repeat(26), "nonce"), identity.publicKey)).toBe(false);
  });

  it("rejects seeds of the wrong size", () => {
    expect(() => remoteIdentity(new Uint8Array(16))).toThrow(RangeError);
  });
});

describe("frames", () => {
  it("parses well-formed frames and refuses the rest", () => {
    expect(parseRelayFrame(JSON.stringify({ type: "request", id: 4, method: "POST", target: "/mcp", headers: { a: "b" }, body: "{}" }))).toEqual({
      type: "request",
      id: 4,
      method: "POST",
      target: "/mcp",
      headers: { a: "b" },
      body: "{}",
    });
    expect(parsePhoneFrame(JSON.stringify({ type: "response", id: 4, status: 200, headers: {}, body: "" }))?.type).toBe("response");
    expect(parsePhoneFrame(JSON.stringify({ type: "response", id: 4, status: 42, headers: {}, body: "" }))).toBeNull();
    expect(parseRelayFrame("{")).toBeNull();
    expect(parsePhoneFrame(JSON.stringify({ type: "online" }))).toBeNull();
  });
});
