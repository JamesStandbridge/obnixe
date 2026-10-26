export const WHEN_UNLOCKED_THIS_DEVICE_ONLY = 5;

export const secureItems = new Map<string, string>();

export function getItem(key: string): string | null {
  return secureItems.get(key) ?? null;
}

export function setItem(key: string, value: string): void {
  secureItems.set(key, value);
}

export async function deleteItemAsync(key: string): Promise<void> {
  secureItems.delete(key);
}
