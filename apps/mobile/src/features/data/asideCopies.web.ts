import type { EpochMs } from "@obnixe/schema";

export interface AsideCopy {
  readonly name: string;
  readonly setAsideAt: EpochMs;
  readonly bytes: number;
  readonly raw: boolean;
}

export function listAsideCopies(): AsideCopy[] {
  return [];
}

export async function shareAsideCopy(_copy: AsideCopy): Promise<void> {}

export function deleteAsideCopy(_copy: AsideCopy): void {}
