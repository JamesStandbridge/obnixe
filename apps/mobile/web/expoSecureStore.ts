export interface SecureStoreOptions {
  readonly keychainAccessible?: number;
}

export const AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY = 1;
export const WHEN_UNLOCKED_THIS_DEVICE_ONLY = 5;

export function getItem(key: string): string | null {
  return localStorage.getItem(key);
}

export function setItem(key: string, value: string): void {
  localStorage.setItem(key, value);
}

export async function deleteItemAsync(key: string): Promise<void> {
  localStorage.removeItem(key);
}
