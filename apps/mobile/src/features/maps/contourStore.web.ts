/** The browser keeps traced tiles in memory only. */
export async function storedContours(_name: string): Promise<string | null> {
  return null;
}

export async function storeContours(_name: string, _features: string): Promise<void> {}

export function trimContours(): void {}
