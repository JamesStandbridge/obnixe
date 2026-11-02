import * as SecureStore from "expo-secure-store";
import { fromBase64, parseRemoteGrants, remoteIdentity, remoteSeedBytes, toBase64 } from "@obnixe/core";
import type { RandomBytes, RemoteGrant, RemoteIdentity, RemoteVault } from "@obnixe/core";
import type { Id } from "@obnixe/schema";

const options: SecureStore.SecureStoreOptions = { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY };
const keyKey = "obnixe.remote.key";
const grantsKey = "obnixe.remote.grants";
const identityKey = "obnixe.remote.identity";
const enabledKey = "obnixe.remote.enabled";
const signingKeyBytes = 32;

function remove(key: string): void {
  SecureStore.deleteItemAsync(key, options).catch((error: unknown) => ErrorUtils.getGlobalHandler()(error, false));
}

function signingKey(randomBytes: RandomBytes): Uint8Array {
  const stored = SecureStore.getItem(keyKey, options);
  if (stored !== null) return fromBase64(stored);
  const created = randomBytes(signingKeyBytes);
  SecureStore.setItem(keyKey, toBase64(created), options);
  return created;
}

export function readGrants(): readonly RemoteGrant[] {
  const text = SecureStore.getItem(grantsKey, options);
  return text === null ? [] : parseRemoteGrants(text);
}

export function openVault(randomBytes: RandomBytes): RemoteVault {
  return {
    key: signingKey(randomBytes),
    loadGrants: readGrants,
    saveGrants: (grants) => SecureStore.setItem(grantsKey, JSON.stringify(grants), options),
  };
}

/** Agent connections owned by remote grants: they stay open while the app is closed. */
export function remoteConnectionIds(): ReadonlySet<Id> {
  return new Set(readGrants().map((grant) => grant.connectionId));
}

/** The key the phone proves to the relay, which its public address derives from; null until remote access is first enabled. */
export function readIdentity(): RemoteIdentity | null {
  const stored = SecureStore.getItem(identityKey, options);
  return stored === null ? null : remoteIdentity(fromBase64(stored));
}

export function createIdentity(randomBytes: RandomBytes): RemoteIdentity {
  const seed = randomBytes(remoteSeedBytes);
  SecureStore.setItem(identityKey, toBase64(seed), options);
  return remoteIdentity(seed);
}

export function readEnabled(): boolean {
  return SecureStore.getItem(enabledKey, options) === "1";
}

export function saveEnabled(enabled: boolean): void {
  if (enabled) SecureStore.setItem(enabledKey, "1", options);
  else remove(enabledKey);
}
