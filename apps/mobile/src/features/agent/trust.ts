import * as SecureStore from "expo-secure-store";
import { generateIdentity, parsePhonePairing, parsePhoneRevocation } from "@obnixe/core";
import type { PhonePairing, PhoneRevocation, RandomBytes } from "@obnixe/core";

const options: SecureStore.SecureStoreOptions = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };
const deviceKey = "obnixe.agent.device";
const pairingKey = "obnixe.agent.pairing";
const revocationKey = "obnixe.agent.revocation";

function remove(key: string): void {
  SecureStore.deleteItemAsync(key, options).catch((error: unknown) => ErrorUtils.getGlobalHandler()(error, false));
}

export function readDeviceId(randomBytes: RandomBytes): string {
  const stored = SecureStore.getItem(deviceKey, options);
  if (stored !== null) return stored;
  const created = generateIdentity(randomBytes);
  SecureStore.setItem(deviceKey, created, options);
  return created;
}

export function readPairing(): PhonePairing | null {
  const text = SecureStore.getItem(pairingKey, options);
  return text === null ? null : parsePhonePairing(text);
}

export function savePairing(pairing: PhonePairing): void {
  SecureStore.setItem(pairingKey, JSON.stringify(pairing), options);
}

export function deletePairing(): void {
  remove(pairingKey);
}

export function readRevocation(): PhoneRevocation | null {
  const text = SecureStore.getItem(revocationKey, options);
  return text === null ? null : parsePhoneRevocation(text);
}

export function saveRevocation(revocation: PhoneRevocation): void {
  SecureStore.setItem(revocationKey, JSON.stringify(revocation), options);
}

export function deleteRevocation(): void {
  remove(revocationKey);
}
