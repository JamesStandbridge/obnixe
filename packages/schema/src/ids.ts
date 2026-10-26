import type { Id } from "./columns.ts";

export type RandomFill = (bytes: Uint8Array) => void;

export function createIdFactory(fillRandom: RandomFill, now: () => number): () => Id {
  let lastMs = -1;
  let sequence = 0;
  return () => {
    let ms = now();
    if (ms <= lastMs) {
      ms = lastMs;
      sequence = (sequence + 1) & 0xfff;
      if (sequence === 0) ms = lastMs + 1;
    } else {
      sequence = 0;
    }
    lastMs = ms;
    const bytes = new Uint8Array(16);
    fillRandom(bytes);
    for (let index = 5; index >= 0; index -= 1) {
      bytes[index] = ms % 256;
      ms = Math.floor(ms / 256);
    }
    bytes[6] = 0x70 | (sequence >> 8);
    bytes[7] = sequence & 0xff;
    bytes[8] = 0x80 | ((bytes[8] ?? 0) & 0x3f);
    const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}` as Id;
  };
}
