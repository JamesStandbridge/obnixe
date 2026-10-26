import { randomFillSync } from "node:crypto";

export function getRandomValues(values: Uint8Array): Uint8Array {
  return randomFillSync(values);
}
