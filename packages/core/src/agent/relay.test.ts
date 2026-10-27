import { hkdfSync, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { Base64Error, fromBase64Url, toBase64, toBase64Url } from "./encoding.ts";
import { maxFrameBytes } from "./limits.ts";
import { ProtocolError, SealedChannel, decodeFrame, derivePairingSecrets, encodeFrame, fitsSealedFrame, generateEphemeralKeyPair, sharedSecret } from "./protocol.ts";
import type { PairingTranscript } from "./protocol.ts";
import {
  deriveRelayRoom,
  generateRelayRoom,
  isRelayRoom,
  isRelayUrl,
  pairingRelayRoom,
  parseRelayToBridge,
  parseRelayToPhone,
  relayPeerLeftMessage,
  relaySocketUrl,
} from "./relay.ts";

const bytes = (length: number): Uint8Array => new Uint8Array(randomBytes(length));

describe("base64url", () => {
  it("matches Node for every padding length and refuses foreign characters", () => {
    for (let length = 0; length < 40; length += 1) {
      const input = bytes(length);
      const encoded = toBase64Url(input);
      expect(encoded).toBe(Buffer.from(input).toString("base64url"));
      expect(fromBase64Url(encoded)).toEqual(input);
    }
    expect(() => fromBase64Url("ab+/")).toThrow(Base64Error);
    expect(() => fromBase64Url("abcde")).toThrow(Base64Error);
  });
});

describe("relay rooms", () => {
  it("derives the same room on the bridge and on the phone from one code pairing", async () => {
    const bridgeKeys = generateEphemeralKeyPair(bytes);
    const phoneKeys = generateEphemeralKeyPair(bytes);
    const transcript: PairingTranscript = {
      bridgeId: bytes(16),
      bridgeNonce: bytes(32),
      bridgeKey: bridgeKeys.publicKey,
      deviceId: bytes(16),
      phoneNonce: bytes(32),
      phoneKey: phoneKeys.publicKey,
      device: "iPhone",
    };
    const onBridge = await derivePairingSecrets({ kind: "code", code: "482917" }, transcript, sharedSecret(bridgeKeys.secretKey, phoneKeys.publicKey));
    const onPhone = await derivePairingSecrets({ kind: "code", code: "482917" }, transcript, sharedSecret(phoneKeys.secretKey, bridgeKeys.publicKey));
    const bridgeRoom = pairingRelayRoom({ pairingId: toBase64(onBridge.pairingId), secret: toBase64(onBridge.pairingSecret) });
    const phoneRoom = pairingRelayRoom({ pairingId: toBase64(onPhone.pairingId), secret: toBase64(onPhone.pairingSecret) });
    expect(phoneRoom).toBe(bridgeRoom);
    expect(isRelayRoom(bridgeRoom)).toBe(true);
  });

  it("is HKDF-SHA256 of the secret with the room salt and the pairing id as info", () => {
    const secret = bytes(32);
    const pairingId = bytes(16);
    const expected = new Uint8Array(hkdfSync("sha256", secret, "obnixe-relay-room", pairingId, 32));
    expect(deriveRelayRoom(secret, pairingId)).toEqual(expected);
    expect(pairingRelayRoom({ pairingId: toBase64(pairingId), secret: toBase64(secret) })).toBe(Buffer.from(expected).toString("base64url"));
    expect(pairingRelayRoom({ pairingId: toBase64(bytes(16)), secret: toBase64(secret) })).not.toBe(toBase64Url(expected));
  });

  it("generates random one-time rooms", () => {
    const first = generateRelayRoom(bytes);
    expect(isRelayRoom(first)).toBe(true);
    expect(generateRelayRoom(bytes)).not.toBe(first);
    expect(isRelayRoom(`${first}A`)).toBe(false);
  });
});

describe("relay messages", () => {
  it("builds socket URLs and validates relay URLs", () => {
    expect(relaySocketUrl("wss://relay.example.com/")).toBe("wss://relay.example.com/v1");
    expect(isRelayUrl("wss://relay.example.com")).toBe(true);
    expect(isRelayUrl("ws://127.0.0.1:9000")).toBe(true);
    expect(isRelayUrl("https://relay.example.com")).toBe(false);
    expect(isRelayUrl("wss://relay.example.com/?room=1")).toBe(false);
  });

  it("parses what the relay sends and refuses anything else", () => {
    const room = generateRelayRoom(bytes);
    expect(parseRelayToBridge(JSON.stringify({ type: "frame", room, data: "{}" }))).toEqual({ type: "frame", room, data: "{}" });
    expect(parseRelayToBridge(JSON.stringify({ type: "refused", room, reason: "occupied" }))).toEqual({ type: "refused", room, reason: "occupied" });
    expect(parseRelayToPhone(relayPeerLeftMessage)).toEqual({ type: "peer_left" });
    expect(() => parseRelayToBridge(JSON.stringify({ type: "peer", room: "short" }))).toThrow(ProtocolError);
    expect(() => parseRelayToPhone("not json")).toThrow(ProtocolError);
  });
});

describe("frame size", () => {
  it("refuses frames above the shared limit and predicts which sealed answers fit", () => {
    expect(() => decodeFrame(" ".repeat(maxFrameBytes + 1))).toThrow(ProtocolError);
    const channel = new SealedChannel(bytes(32), bytes(32));
    const limit = (maxFrameBytes * 3) / 4 - 200;
    for (const size of [1000, limit - 3000, limit, limit + 3000]) {
      const message = { jsonrpc: "2.0", id: 1, result: { text: "x".repeat(size), isError: false } };
      expect(fitsSealedFrame(message)).toBe(encodeFrame(channel.seal(message)).length <= maxFrameBytes);
    }
    expect(fitsSealedFrame({ text: "x".repeat(maxFrameBytes) })).toBe(false);
  });
});
