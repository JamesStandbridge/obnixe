import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Id } from "@obnixe/schema";
import { Utf8Error, fromBase64, fromUtf8, toBase64 } from "./encoding.ts";
import {
  ProtocolError,
  SealedChannel,
  decodeBytes,
  decodeFrame,
  derivePairingKey,
  deriveSessionKeys,
  encodeFrame,
  generatePairingCode,
  helloProof,
  isPairingCode,
  parsePhoneMessage,
  protocolVersion,
  sameBytes,
  welcomeProof,
} from "./protocol.ts";
import type { Frame, PairingTranscript } from "./protocol.ts";
import { PhoneSession } from "./session.ts";
import type { PhoneLinkStatus } from "./session.ts";

const bytes = (length: number): Uint8Array => new Uint8Array(randomBytes(length));

describe("base64", () => {
  it("round-trips every padding length", () => {
    for (let length = 0; length < 40; length += 1) {
      const input = bytes(length);
      const encoded = toBase64(input);
      expect(encoded).toBe(Buffer.from(input).toString("base64"));
      expect(fromBase64(encoded)).toEqual(input);
    }
  });

  it("rejects malformed payloads as protocol errors", () => {
    expect(() => decodeBytes("abc")).toThrow(ProtocolError);
    expect(() => decodeBytes("ab$=")).toThrow(ProtocolError);
    expect(() => decodeBytes(toBase64(bytes(16)), 32)).toThrow(ProtocolError);
  });
});

describe("utf8", () => {
  it("decodes like TextDecoder and rejects malformed input", () => {
    const text = "Développé couché · 9,2 km · 漢字 · \u{1F3C3}";
    expect(fromUtf8(new TextEncoder().encode(text))).toBe(text);
    expect(fromUtf8(new TextEncoder().encode("x".repeat(10_000)))).toHaveLength(10_000);
    for (const bad of [[0xc3], [0xc0, 0x80], [0xed, 0xa0, 0x80], [0xf5, 0x80, 0x80, 0x80], [0x80]]) {
      expect(() => fromUtf8(new Uint8Array(bad))).toThrow(Utf8Error);
    }
  });
});

describe("pairing code", () => {
  it("is six digits", () => {
    for (let index = 0; index < 200; index += 1) expect(isPairingCode(generatePairingCode(bytes))).toBe(true);
  });

  it("rejects biased draws", () => {
    const draws = [new Uint8Array([0xff, 0xff, 0xff, 0xff]), new Uint8Array([0, 0, 0x30, 0x39])];
    expect(generatePairingCode(() => draws.shift() ?? new Uint8Array(4))).toBe("012345");
  });
});

describe("pairing proofs", () => {
  const transcript: PairingTranscript = { bridgeNonce: bytes(32), phoneNonce: bytes(32), device: "iPhone" };

  it("only verify with the same code", async () => {
    const phoneKey = await derivePairingKey("482917", transcript);
    const bridgeKey = await derivePairingKey("482917", transcript);
    const wrongKey = await derivePairingKey("482918", transcript);
    expect(sameBytes(helloProof(phoneKey, transcript), helloProof(bridgeKey, transcript))).toBe(true);
    expect(sameBytes(helloProof(phoneKey, transcript), helloProof(wrongKey, transcript))).toBe(false);
    expect(sameBytes(helloProof(phoneKey, transcript), welcomeProof(phoneKey, transcript))).toBe(false);
  });

  it("bind the nonces", async () => {
    const key = await derivePairingKey("482917", transcript);
    const replayed = { ...transcript, bridgeNonce: bytes(32) };
    expect(sameBytes(helloProof(key, transcript), helloProof(await derivePairingKey("482917", replayed), replayed))).toBe(false);
  });
});

describe("sealed channel", () => {
  const keys = { toPhone: bytes(32), toBridge: bytes(32) };

  it("delivers messages in order in both directions", () => {
    const bridge = new SealedChannel(keys.toPhone, keys.toBridge);
    const phone = new SealedChannel(keys.toBridge, keys.toPhone);
    expect(phone.open(bridge.seal({ hello: 1 }))).toEqual({ hello: 1 });
    expect(phone.open(bridge.seal({ hello: 2 }))).toEqual({ hello: 2 });
    expect(bridge.open(phone.seal(["é", 3]))).toEqual(["é", 3]);
  });

  it("rejects tampered, replayed and reordered frames", () => {
    const bridge = new SealedChannel(keys.toPhone, keys.toBridge);
    const phone = new SealedChannel(keys.toBridge, keys.toPhone);
    const first = bridge.seal({ n: 1 });
    const second = bridge.seal({ n: 2 });
    const tampered = fromBase64(first.box);
    tampered[0] = (tampered[0] ?? 0) ^ 1;
    expect(() => phone.open({ ...first, box: toBase64(tampered) })).toThrow(ProtocolError);
    expect(() => phone.open(second)).toThrow(ProtocolError);
    expect(phone.open(first)).toEqual({ n: 1 });
    expect(() => phone.open(first)).toThrow(ProtocolError);
    expect(() => new SealedChannel(bytes(32), keys.toPhone).open(second)).toThrow(ProtocolError);
  });
});

describe("frames", () => {
  it("round-trip and reject garbage", () => {
    const frame: Frame = { type: "challenge", version: protocolVersion, nonce: toBase64(bytes(32)) };
    expect(decodeFrame(encodeFrame(frame))).toEqual(frame);
    expect(() => decodeFrame("{")).toThrow(ProtocolError);
    expect(() => decodeFrame(JSON.stringify({ type: "sealed", seq: -1, box: "" }))).toThrow(ProtocolError);
  });
});

describe("PhoneSession", () => {
  interface Harness {
    readonly session: PhoneSession;
    readonly sent: Frame[];
    readonly statuses: PhoneLinkStatus[];
    readonly calls: string[];
    closed: boolean;
  }

  function harness(code: string): Harness {
    const sent: Frame[] = [];
    const statuses: PhoneLinkStatus[] = [];
    const calls: string[] = [];
    const state = { closed: false };
    const session = new PhoneSession({
      code,
      device: "iPhone",
      randomBytes: bytes,
      now: () => 0,
      socket: { send: (text) => sent.push(decodeFrame(text)), close: () => (state.closed = true) },
      handlers: {
        onStatus: (status) => statuses.push(status),
        onOpen: () => "connection-1" as Id,
        onClient: () => undefined,
        onCall: (_connectionId, tool) => {
          calls.push(tool);
          return { text: "{}", isError: false };
        },
        onRejected: () => undefined,
      },
    });
    return {
      session,
      sent,
      statuses,
      calls,
      get closed() {
        return state.closed;
      },
    };
  }

  async function pair(target: Harness, code: string): Promise<SealedChannel> {
    const bridgeNonce = bytes(32);
    await target.session.receive(encodeFrame({ type: "challenge", version: protocolVersion, nonce: toBase64(bridgeNonce) }));
    const hello = target.sent.at(-1);
    if (hello?.type !== "hello") throw new Error("Expected a hello");
    const transcript: PairingTranscript = { bridgeNonce, phoneNonce: decodeBytes(hello.nonce), device: hello.device };
    const key = await derivePairingKey(code, transcript);
    expect(sameBytes(decodeBytes(hello.proof), helloProof(key, transcript))).toBe(code === "482917");
    const welcome = encodeFrame({ type: "welcome", proof: toBase64(welcomeProof(key, transcript)) });
    if (code !== "482917") {
      await expect(target.session.receive(welcome)).rejects.toThrow(ProtocolError);
      return new SealedChannel(bytes(32), bytes(32));
    }
    await target.session.receive(welcome);
    const keys = deriveSessionKeys(key, transcript);
    return new SealedChannel(keys.toPhone, keys.toBridge);
  }

  it("pairs, opens and serves tool calls", async () => {
    const target = harness("482917");
    const channel = await pair(target, "482917");
    expect(target.statuses).toEqual(["proving", "waiting"]);
    await target.session.receive(encodeFrame(channel.seal({ jsonrpc: "2.0", id: 1, method: "session.open", params: { client: "Cursor", host: "MacBook Pro" } })));
    expect(target.session.connectionId).toBe("connection-1");
    const opened = target.sent.at(-1);
    if (opened?.type !== "sealed") throw new Error("Expected a sealed reply");
    expect(parsePhoneMessage(channel.open(opened))).toEqual({ jsonrpc: "2.0", id: 1, result: { connectionId: "connection-1" } });
    await target.session.receive(encodeFrame(channel.seal({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "list_sports", arguments: {} } })));
    const reply = target.sent.at(-1);
    if (reply?.type !== "sealed") throw new Error("Expected a sealed reply");
    expect(parsePhoneMessage(channel.open(reply))).toEqual({ jsonrpc: "2.0", id: 2, result: { text: "{}", isError: false } });
    expect(target.calls).toEqual(["list_sports"]);
    target.session.close("user");
    const goodbye = target.sent.at(-1);
    if (goodbye?.type !== "sealed") throw new Error("Expected a sealed goodbye");
    expect(parsePhoneMessage(channel.open(goodbye))).toEqual({ jsonrpc: "2.0", method: "session.close", params: { reason: "user" } });
    expect(target.closed).toBe(true);
    expect(target.statuses.at(-1)).toBe("closed");
  });

  it("refuses a bridge that does not know the code", async () => {
    const target = harness("482917");
    await pair(target, "111111");
    expect(target.session.connectionId).toBeNull();
  });

  it("refuses sealed frames before pairing", async () => {
    const target = harness("482917");
    const channel = new SealedChannel(bytes(32), bytes(32));
    await expect(target.session.receive(encodeFrame(channel.seal({ jsonrpc: "2.0", method: "ping" })))).rejects.toThrow(ProtocolError);
  });
});
