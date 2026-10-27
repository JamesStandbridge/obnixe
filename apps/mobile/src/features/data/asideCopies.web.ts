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

export type ShareOutcome = { readonly kind: "shared" } | { readonly kind: "separate"; readonly fileCount: number };

export async function shareAsideCopy(_copy: AsideCopy): Promise<ShareOutcome> {
  return { kind: "shared" };
}

export async function shareSeparately(_copy: AsideCopy): Promise<void> {}

export function sweepExports(): void {}

export function deleteAsideCopy(_copy: AsideCopy): void {}
