import { describe, expect, it } from "vitest";
import type { PhonePairing, PhoneRevocation } from "@obnixe/core";
import {
  deleteForgottenNotice,
  deletePairing,
  deleteRevocation,
  readDeviceId,
  readForgottenNotice,
  readPairing,
  readRevocation,
  saveForgottenNotice,
  savePairing,
  saveRevocation,
} from "@/features/agent/trust";
import { randomBytes } from "../../../test/fakeBridge.ts";
import { secureItems } from "../../../test/mocks/expoSecureStore.ts";

const pairing: PhonePairing = { pairingId: "cGFpcmluZw==", bridgeId: "YnJpZGdl", bridgeName: "MacBook Pro", secret: "c2VjcmV0", hosts: ["192.168.1.24:7429"], lastHost: null, relay: null };
const revocation: PhoneRevocation = { bridgeId: "YnJpZGdl", pairingId: "cGFpcmluZw==", proof: "cHJvb2Y=" };

describe("device id", () => {
  it("is created once and then read back", () => {
    const created = readDeviceId(randomBytes);
    expect(created).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect(readDeviceId(() => new Uint8Array(16))).toBe(created);
    expect([...secureItems.values()]).toEqual([created]);
  });
});

describe("pairing", () => {
  it("round-trips and is deleted", () => {
    expect(readPairing()).toBeNull();
    savePairing(pairing);
    expect(readPairing()).toEqual(pairing);
    deletePairing();
    expect(readPairing()).toBeNull();
  });

  it("reads an unreadable or incomplete entry as no pairing", () => {
    secureItems.set("obnixe.agent.pairing", "{");
    expect(readPairing()).toBeNull();
    secureItems.set("obnixe.agent.pairing", JSON.stringify({ pairingId: "cGFpcmluZw==" }));
    expect(readPairing()).toBeNull();
  });
});

describe("revocation", () => {
  it("round-trips, is deleted and ignores unreadable entries", () => {
    expect(readRevocation()).toBeNull();
    saveRevocation(revocation);
    expect(readRevocation()).toEqual(revocation);
    deleteRevocation();
    expect(readRevocation()).toBeNull();
    secureItems.set("obnixe.agent.revocation", "not json");
    expect(readRevocation()).toBeNull();
  });
});

describe("forgotten notice", () => {
  it("remembers the pairing it was shown for until deleted", () => {
    expect(readForgottenNotice()).toBeNull();
    saveForgottenNotice(pairing.pairingId);
    expect(readForgottenNotice()).toBe(pairing.pairingId);
    deleteForgottenNotice();
    expect(readForgottenNotice()).toBeNull();
  });
});
