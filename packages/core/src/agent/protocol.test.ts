import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Id } from "@obnixe/schema";
import { sameBytes } from "../bytes.ts";
import { Utf8Error, fromBase64, fromUtf8, toBase64 } from "./encoding.ts";
import {
  ProtocolError,
  SealedChannel,
  bridgeProof,
  commitBridgeProof,
  decodeBytes,
  decodeFrame,
  derivePairingSecrets,
  deriveResumeSecrets,
  encodeFrame,
  generateEphemeralKeyPair,
  generatePairingCode,
  isPairingCode,
  parsePhoneMessage,
  phoneProof,
  protocolVersion,
  resumeBridgeProof,
  resumePhoneProof,
  revocationProof,
  sharedSecret,
} from "./protocol.ts";
import type { EphemeralKeyPair, Frame, HandshakeSecrets, PairingSecrets, PairingTranscript, RejectionReason } from "./protocol.ts";
import { PhoneSession, parsePhonePairing, phoneRevocation } from "./session.ts";
import type { PhoneLinkStatus, PhonePairing, PhoneRevocation } from "./session.ts";

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

const code = "482917";

type ChallengeFrame = Extract<Frame, { type: "challenge" }>;
type HelloFrame = Extract<Frame, { type: "hello" }>;
type ResumeFrame = Extract<Frame, { type: "resume" }>;

interface SimulatedBridge {
  readonly id: Uint8Array;
  readonly nonce: Uint8Array;
  readonly keyPair: EphemeralKeyPair;
}

interface Commitment {
  readonly opening: Uint8Array;
  readonly commitment: Uint8Array;
}

const bridgeId = bytes(16);
const deviceId = toBase64(bytes(16));

function simulatedBridge(id: Uint8Array = bridgeId): SimulatedBridge {
  return { id, nonce: bytes(32), keyPair: generateEphemeralKeyPair(bytes) };
}

function challengeOf(bridge: SimulatedBridge): ChallengeFrame {
  return { type: "challenge", version: protocolVersion, bridge: toBase64(bridge.id), nonce: toBase64(bridge.nonce), key: toBase64(bridge.keyPair.publicKey) };
}

function transcriptOf(bridge: SimulatedBridge, hello: HelloFrame | ResumeFrame): PairingTranscript {
  return {
    bridgeId: bridge.id,
    bridgeNonce: bridge.nonce,
    bridgeKey: bridge.keyPair.publicKey,
    deviceId: decodeBytes(hello.deviceId),
    phoneNonce: decodeBytes(hello.nonce),
    phoneKey: decodeBytes(hello.key),
    device: hello.device,
  };
}

function bridgeSecrets(bridge: SimulatedBridge, hello: HelloFrame, typed: string): Promise<PairingSecrets> {
  const transcript = transcriptOf(bridge, hello);
  return derivePairingSecrets(typed, transcript, sharedSecret(bridge.keyPair.secretKey, transcript.phoneKey));
}

function commitTo(secrets: PairingSecrets): Commitment {
  const opening = bytes(32);
  return { opening, commitment: commitBridgeProof(opening, bridgeProof(secrets)) };
}

function welcomeFor(secrets: PairingSecrets, commitment: Commitment): Frame {
  return { type: "welcome", opening: toBase64(commitment.opening), proof: toBase64(bridgeProof(secrets)) };
}

interface Harness {
  readonly session: PhoneSession;
  readonly sent: Frame[];
  readonly statuses: PhoneLinkStatus[];
  readonly calls: string[];
  readonly paired: PhonePairing[];
  readonly rejections: RejectionReason[];
  readonly revocationsAcknowledged: PhoneRevocation[];
  readonly closed: boolean;
}

interface Trust {
  readonly pairing?: PhonePairing;
  readonly revocation?: PhoneRevocation;
}

function harness(phoneCode: string, trust: Trust = {}): Harness {
  const sent: Frame[] = [];
  const statuses: PhoneLinkStatus[] = [];
  const calls: string[] = [];
  const paired: PhonePairing[] = [];
  const rejections: RejectionReason[] = [];
  const revocationsAcknowledged: PhoneRevocation[] = [];
  const state = { closed: false };
  const session = new PhoneSession({
    code: phoneCode,
    device: "iPhone",
    deviceId,
    pairing: trust.pairing ?? null,
    revocation: trust.revocation ?? null,
    randomBytes: bytes,
    now: () => 0,
    socket: { send: (text) => sent.push(decodeFrame(text)), close: () => (state.closed = true) },
    handlers: {
      onStatus: (status) => statuses.push(status),
      onOpen: () => "connection-1" as Id,
      onClient: () => undefined,
      onCall: (_connectionId, tool) => {
        calls.push(tool);
        if (tool === "explode") throw new RangeError("disk full");
        return { text: "{}", isError: false };
      },
      onRejected: (reason) => rejections.push(reason),
      onPaired: (pairing) => paired.push(pairing),
      onRevocationAcknowledged: (revocation) => revocationsAcknowledged.push(revocation),
    },
  });
  return {
    session,
    sent,
    statuses,
    calls,
    paired,
    rejections,
    revocationsAcknowledged,
    get closed() {
      return state.closed;
    },
  };
}

function lastSent<T extends Frame["type"]>(target: Harness, type: T): Extract<Frame, { type: T }> {
  const frame = target.sent.at(-1);
  if (frame?.type !== type) throw new Error(`Expected a ${type} frame, got ${frame?.type ?? "nothing"}`);
  return frame as Extract<Frame, { type: T }>;
}

async function helloFrom(target: Harness, bridge: SimulatedBridge): Promise<HelloFrame> {
  await target.session.receive(encodeFrame(challengeOf(bridge)));
  return lastSent(target, "hello");
}

async function proofFrom(target: Harness, commitment: Commitment): Promise<Uint8Array> {
  await target.session.receive(encodeFrame({ type: "commit", commitment: toBase64(commitment.commitment) }));
  return decodeBytes(lastSent(target, "proof").proof);
}

interface Paired {
  readonly channel: SealedChannel;
  readonly bridge: SimulatedBridge;
  readonly hello: HelloFrame;
  readonly proof: Uint8Array;
  readonly secrets: PairingSecrets;
}

async function pair(target: Harness): Promise<Paired> {
  const bridge = simulatedBridge();
  const hello = await helloFrom(target, bridge);
  const secrets = await bridgeSecrets(bridge, hello, code);
  const commitment = commitTo(secrets);
  const proof = await proofFrom(target, commitment);
  expect(sameBytes(proof, phoneProof(secrets, commitment.commitment))).toBe(true);
  await target.session.receive(encodeFrame(welcomeFor(secrets, commitment)));
  return { channel: new SealedChannel(secrets.sessionKeys.toPhone, secrets.sessionKeys.toBridge), bridge, hello, proof, secrets };
}

describe("pairing handshake", () => {
  it("pairs with the right code and agrees on session keys", async () => {
    const target = harness(code);
    const { channel } = await pair(target);
    await target.session.receive(encodeFrame(channel.seal({ jsonrpc: "2.0", id: 1, method: "session.open", params: { client: "Cursor", host: "MacBook Pro" } })));
    expect(parsePhoneMessage(channel.open(lastSent(target, "sealed")))).toEqual({ jsonrpc: "2.0", id: 1, result: { connectionId: "connection-1" } });
  });

  it("keeps a recorded transcript sealed from an observer who knows the code", async () => {
    const target = harness(code);
    const { channel, bridge, hello } = await pair(target);
    await target.session.receive(encodeFrame(channel.seal({ jsonrpc: "2.0", id: 1, method: "session.open", params: { client: "Cursor", host: "MacBook Pro" } })));
    const recorded = lastSent(target, "sealed");
    const transcript = transcriptOf(bridge, hello);
    const observer = generateEphemeralKeyPair(bytes);
    const guesses = [sharedSecret(observer.secretKey, transcript.phoneKey), sharedSecret(observer.secretKey, transcript.bridgeKey), new Uint8Array(32)];
    for (const guess of guesses) {
      const secrets = await derivePairingSecrets(code, transcript, guess);
      expect(() => new SealedChannel(secrets.sessionKeys.toPhone, secrets.sessionKeys.toBridge).open(recorded)).toThrow(ProtocolError);
      expect(sameBytes(bridgeProof(secrets), bridgeProof(await bridgeSecrets(bridge, hello, code)))).toBe(false);
    }
  });

  it("rejects a wrong code in both directions", async () => {
    const target = harness(code);
    const bridge = simulatedBridge();
    const hello = await helloFrom(target, bridge);
    const wrong = await bridgeSecrets(bridge, hello, "111111");
    const commitment = commitTo(wrong);
    const proof = await proofFrom(target, commitment);
    expect(sameBytes(proof, phoneProof(wrong, commitment.commitment))).toBe(false);
    await expect(target.session.receive(encodeFrame(welcomeFor(wrong, commitment)))).rejects.toThrow(ProtocolError);
    expect(target.session.connectionId).toBeNull();
  });

  it("stops a fake bridge that learns the code after committing", async () => {
    const target = harness(code);
    const bridge = simulatedBridge();
    const hello = await helloFrom(target, bridge);
    const guessed = commitTo(await bridgeSecrets(bridge, hello, "111111"));
    await proofFrom(target, guessed);
    const cracked = await bridgeSecrets(bridge, hello, code);
    await expect(target.session.receive(encodeFrame(welcomeFor(cracked, guessed)))).rejects.toThrow(ProtocolError);
  });

  it("rejects a replayed hello and proof", async () => {
    const recorded = await pair(harness(code));
    const replayTarget = simulatedBridge();
    const secrets = await bridgeSecrets(replayTarget, recorded.hello, code);
    const commitment = commitTo(secrets);
    expect(sameBytes(recorded.proof, phoneProof(secrets, commitment.commitment))).toBe(false);
  });

  it("rejects a tampered public key in either direction", async () => {
    const bridge = simulatedBridge();
    const target = harness(code);
    const intruder = generateEphemeralKeyPair(bytes);
    const hello = await helloFrom(target, { id: bridge.id, nonce: bridge.nonce, keyPair: intruder });
    const secrets = await bridgeSecrets(bridge, hello, code);
    const commitment = commitTo(secrets);
    expect(sameBytes(await proofFrom(target, commitment), phoneProof(secrets, commitment.commitment))).toBe(false);
    await expect(target.session.receive(encodeFrame(welcomeFor(secrets, commitment)))).rejects.toThrow(ProtocolError);

    const honest = harness(code);
    const honestHello = await helloFrom(honest, bridge);
    const swapped = await bridgeSecrets(bridge, { ...honestHello, key: toBase64(intruder.publicKey) }, code);
    const swappedCommitment = commitTo(swapped);
    expect(sameBytes(await proofFrom(honest, swappedCommitment), phoneProof(swapped, swappedCommitment.commitment))).toBe(false);
  });

  it("refuses low-order public keys", async () => {
    const target = harness(code);
    const challenge: Frame = { ...challengeOf(simulatedBridge()), key: toBase64(new Uint8Array(32)) };
    await expect(target.session.receive(encodeFrame(challenge))).rejects.toThrow(ProtocolError);
  });
});

const openSession = { jsonrpc: "2.0", id: 1, method: "session.open", params: { client: "Cursor", host: "MacBook Pro" } } as const;

interface TrustedPair {
  readonly pairing: PhonePairing;
  readonly secrets: PairingSecrets;
}

async function trustedPair(): Promise<TrustedPair> {
  const target = harness(code);
  const { channel, secrets } = await pair(target);
  expect(target.paired).toEqual([]);
  await target.session.receive(encodeFrame(channel.seal(openSession)));
  const [pairing] = target.paired;
  if (pairing === undefined) throw new Error("Expected a stored pairing");
  return { pairing, secrets };
}

async function resumeFrom(target: Harness, bridge: SimulatedBridge): Promise<ResumeFrame> {
  await target.session.receive(encodeFrame(challengeOf(bridge)));
  return lastSent(target, "resume");
}

function bridgeResumeSecrets(bridge: SimulatedBridge, resume: ResumeFrame, pairingSecret: Uint8Array): HandshakeSecrets {
  const transcript = transcriptOf(bridge, resume);
  return deriveResumeSecrets(pairingSecret, { ...transcript, pairingId: decodeBytes(resume.pairing) }, sharedSecret(bridge.keyPair.secretKey, transcript.phoneKey));
}

describe("trusted resume", () => {
  it("stores a pairing bound to the bridge and the device once a code pairing opens", async () => {
    const { pairing, secrets } = await trustedPair();
    expect(pairing).toEqual({ pairingId: toBase64(secrets.pairingId), bridgeId: toBase64(bridgeId), bridgeName: "MacBook Pro", secret: toBase64(secrets.pairingSecret) });
    expect(parsePhonePairing(JSON.stringify(pairing))).toEqual(pairing);
    expect(parsePhonePairing("{")).toBeNull();

    const other = harness(code);
    const bridge = simulatedBridge();
    const hello = await helloFrom(other, bridge);
    const forOtherDevice = await bridgeSecrets(bridge, { ...hello, deviceId: toBase64(bytes(16)) }, code);
    const forOtherBridge = await bridgeSecrets({ ...bridge, id: bytes(16) }, hello, code);
    const honest = await bridgeSecrets(bridge, hello, code);
    for (const tampered of [forOtherDevice, forOtherBridge]) {
      expect(sameBytes(tampered.pairingSecret, honest.pairingSecret)).toBe(false);
      expect(sameBytes(tampered.pairingId, honest.pairingId)).toBe(false);
    }
  });

  it("resumes without a code, with fresh keys, and opens a new connection", async () => {
    const { pairing, secrets } = await trustedPair();
    const target = harness("000000", { pairing });
    const bridge = simulatedBridge();
    const resume = await resumeFrom(target, bridge);
    expect(target.statuses).toEqual(["resuming"]);
    expect(resume.pairing).toBe(pairing.pairingId);
    const resumed = bridgeResumeSecrets(bridge, resume, secrets.pairingSecret);
    expect(sameBytes(decodeBytes(resume.proof), resumePhoneProof(resumed))).toBe(true);
    expect(sameBytes(resumed.sessionKeys.toPhone, secrets.sessionKeys.toPhone)).toBe(false);
    await target.session.receive(encodeFrame({ type: "resumed", proof: toBase64(resumeBridgeProof(resumed)) }));
    const channel = new SealedChannel(resumed.sessionKeys.toPhone, resumed.sessionKeys.toBridge);
    await target.session.receive(encodeFrame(channel.seal(openSession)));
    expect(parsePhoneMessage(channel.open(lastSent(target, "sealed")))).toEqual({ jsonrpc: "2.0", id: 1, result: { connectionId: "connection-1" } });
    expect(target.statuses.at(-1)).toBe("open");
    expect(target.paired).toEqual([]);
    expect(target.session.codeExposed).toBe(false);
  });

  it("fails both proofs when the secrets differ", async () => {
    const { pairing } = await trustedPair();
    const target = harness(code, { pairing });
    const bridge = simulatedBridge();
    const resume = await resumeFrom(target, bridge);
    const wrong = bridgeResumeSecrets(bridge, resume, bytes(32));
    expect(sameBytes(decodeBytes(resume.proof), resumePhoneProof(wrong))).toBe(false);
    await expect(target.session.receive(encodeFrame({ type: "resumed", proof: toBase64(resumeBridgeProof(wrong)) }))).rejects.toThrow(ProtocolError);
    expect(target.session.connectionId).toBeNull();
  });

  it("reports an unknown or revoked pairing so the phone can fall back to a code", async () => {
    const { pairing } = await trustedPair();
    for (const reason of ["unknown", "revoked"] as const) {
      const target = harness(code, { pairing });
      await resumeFrom(target, simulatedBridge());
      await target.session.receive(encodeFrame({ type: "rejected", reason }));
      expect(target.rejections).toEqual([reason]);
      expect(target.session.isClosed).toBe(true);
      expect(target.closed).toBe(true);
    }
  });

  it("refuses a replayed resume transcript in either direction", async () => {
    const { pairing, secrets } = await trustedPair();
    const firstBridge = simulatedBridge();
    const first = harness(code, { pairing });
    const recorded = await resumeFrom(first, firstBridge);
    const recordedResumed: Frame = { type: "resumed", proof: toBase64(resumeBridgeProof(bridgeResumeSecrets(firstBridge, recorded, secrets.pairingSecret))) };

    const laterBridge = simulatedBridge();
    const replayed = bridgeResumeSecrets(laterBridge, recorded, secrets.pairingSecret);
    expect(sameBytes(decodeBytes(recorded.proof), resumePhoneProof(replayed))).toBe(false);

    const later = harness(code, { pairing });
    await resumeFrom(later, laterBridge);
    await expect(later.session.receive(encodeFrame(recordedResumed))).rejects.toThrow(ProtocolError);
  });

  it("never sends a resume proof to another bridge and never reflects proofs", async () => {
    const { pairing, secrets } = await trustedPair();
    const target = harness(code, { pairing });
    await helloFrom(target, simulatedBridge(bytes(16)));
    expect(target.sent.some((frame) => frame.type === "resume")).toBe(false);
    expect(target.statuses).toEqual(["proving", "waiting"]);

    const honest = harness(code, { pairing });
    const bridge = simulatedBridge();
    const resume = await resumeFrom(honest, bridge);
    const resumed = bridgeResumeSecrets(bridge, resume, secrets.pairingSecret);
    expect(sameBytes(resumePhoneProof(resumed), resumeBridgeProof(resumed))).toBe(false);
    await expect(honest.session.receive(encodeFrame({ type: "resumed", proof: resume.proof }))).rejects.toThrow(ProtocolError);
    const leaked = JSON.stringify(honest.sent);
    expect(leaked).not.toContain(pairing.secret);
  });

  it("sends a revocation token to its bridge only, before the hello", async () => {
    const { pairing, secrets } = await trustedPair();
    const revocation = phoneRevocation(pairing);
    expect(sameBytes(decodeBytes(revocation.proof), revocationProof(secrets.pairingSecret, secrets.pairingId))).toBe(true);

    const elsewhere = harness(code, { revocation });
    await helloFrom(elsewhere, simulatedBridge(bytes(16)));
    expect(elsewhere.sent.map((frame) => frame.type)).toEqual(["hello"]);
    await elsewhere.session.receive(encodeFrame({ type: "rejected", reason: "code" }));
    expect(elsewhere.revocationsAcknowledged).toEqual([]);

    const target = harness(code, { revocation });
    await helloFrom(target, simulatedBridge());
    expect(target.sent.map((frame) => frame.type)).toEqual(["revoke", "hello"]);
    expect(target.sent[0]).toEqual({ type: "revoke", pairing: pairing.pairingId, proof: revocation.proof });
    expect(JSON.stringify(target.sent)).not.toContain(pairing.secret);
  });

  it("only counts a revocation as delivered once the bridge answers after it", async () => {
    const { pairing } = await trustedPair();
    const revocation = phoneRevocation(pairing);

    const lost = harness(code, { revocation });
    await helloFrom(lost, simulatedBridge());
    lost.session.markClosed();
    expect(lost.revocationsAcknowledged).toEqual([]);

    const replaced = harness(code, { revocation });
    await helloFrom(replaced, simulatedBridge());
    await replaced.session.receive(encodeFrame({ type: "rejected", reason: "replaced" }));
    expect(replaced.revocationsAcknowledged).toEqual([]);

    const answered = harness(code, { revocation });
    const bridge = simulatedBridge();
    const hello = await helloFrom(answered, bridge);
    expect(answered.revocationsAcknowledged).toEqual([]);
    await proofFrom(answered, commitTo(await bridgeSecrets(bridge, hello, code)));
    expect(answered.revocationsAcknowledged).toEqual([revocation]);
    await answered.session.receive(encodeFrame({ type: "rejected", reason: "code" }));
    expect(answered.revocationsAcknowledged).toEqual([revocation]);
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
    const frame: Frame = { type: "challenge", version: protocolVersion, bridge: toBase64(bytes(16)), nonce: toBase64(bytes(32)), key: toBase64(bytes(32)) };
    expect(decodeFrame(encodeFrame(frame))).toEqual(frame);
    expect(() => decodeFrame("{")).toThrow(ProtocolError);
    expect(() => decodeFrame(JSON.stringify({ type: "sealed", seq: -1, box: "" }))).toThrow(ProtocolError);
  });
});

describe("PhoneSession", () => {
  it("pairs, opens and serves tool calls", async () => {
    const target = harness(code);
    const { channel } = await pair(target);
    expect(target.statuses).toEqual(["proving", "waiting"]);
    await target.session.receive(encodeFrame(channel.seal({ jsonrpc: "2.0", id: 1, method: "session.open", params: { client: "Cursor", host: "MacBook Pro" } })));
    expect(target.session.connectionId).toBe("connection-1");
    expect(parsePhoneMessage(channel.open(lastSent(target, "sealed")))).toEqual({ jsonrpc: "2.0", id: 1, result: { connectionId: "connection-1" } });
    await target.session.receive(encodeFrame(channel.seal({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "list_sports", arguments: {} } })));
    expect(parsePhoneMessage(channel.open(lastSent(target, "sealed")))).toEqual({ jsonrpc: "2.0", id: 2, result: { text: "{}", isError: false } });
    expect(target.calls).toEqual(["list_sports"]);
    target.session.close("user");
    expect(parsePhoneMessage(channel.open(lastSent(target, "sealed")))).toEqual({ jsonrpc: "2.0", method: "session.close", params: { reason: "user" } });
    expect(target.closed).toBe(true);
    expect(target.statuses.at(-1)).toBe("closed");
  });

  it("answers and closes with reason error when a tool handler throws", async () => {
    const target = harness(code);
    const { channel } = await pair(target);
    await target.session.receive(encodeFrame(channel.seal({ jsonrpc: "2.0", id: 1, method: "session.open", params: { client: "Cursor", host: "MacBook Pro" } })));
    channel.open(lastSent(target, "sealed"));
    await expect(target.session.receive(encodeFrame(channel.seal({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "explode", arguments: {} } })))).rejects.toThrow(RangeError);
    const [reply, goodbye] = target.sent.slice(-2);
    if (reply?.type !== "sealed" || goodbye?.type !== "sealed") throw new Error("Expected sealed frames");
    expect(parsePhoneMessage(channel.open(reply))).toEqual({ jsonrpc: "2.0", id: 2, error: { code: -32603, message: "The phone failed to run the tool" } });
    expect(parsePhoneMessage(channel.open(goodbye))).toEqual({ jsonrpc: "2.0", method: "session.close", params: { reason: "error" } });
    expect(target.session.isClosed).toBe(true);
    expect(target.session.connectionId).toBe("connection-1");
    expect(target.closed).toBe(true);
  });

  it("marks the code exposed once its proof has left the phone", async () => {
    const target = harness(code);
    const bridge = simulatedBridge();
    const hello = await helloFrom(target, bridge);
    expect(target.session.codeExposed).toBe(false);
    await proofFrom(target, commitTo(await bridgeSecrets(bridge, hello, code)));
    expect(target.session.codeExposed).toBe(true);
  });

  it("handles frames in arrival order while the code secrets are still being derived", async () => {
    const target = harness(code);
    const bridge = simulatedBridge();
    const hello = await helloFrom(target, bridge);
    const secrets = await bridgeSecrets(bridge, hello, code);
    const commitment = commitTo(secrets);
    const channel = new SealedChannel(secrets.sessionKeys.toPhone, secrets.sessionKeys.toBridge);
    await Promise.all([
      target.session.receive(encodeFrame({ type: "commit", commitment: toBase64(commitment.commitment) })),
      target.session.receive(encodeFrame(welcomeFor(secrets, commitment))),
      target.session.receive(encodeFrame(channel.seal(openSession))),
    ]);
    expect(parsePhoneMessage(channel.open(lastSent(target, "sealed")))).toEqual({ jsonrpc: "2.0", id: 1, result: { connectionId: "connection-1" } });
  });

  it("refuses sealed frames before pairing", async () => {
    const target = harness(code);
    const channel = new SealedChannel(bytes(32), bytes(32));
    await expect(target.session.receive(encodeFrame(channel.seal({ jsonrpc: "2.0", method: "ping" })))).rejects.toThrow(ProtocolError);
  });
});
