export const importErrorReasons = [
  "unsupported_format",
  "malformed",
  "checksum",
  "truncated",
  "not_an_activity",
  "several_activities",
  "no_activity_data",
  "untimed",
  "unordered_time",
  "invalid_coordinates",
  "invalid_value",
] as const;
export type ImportErrorReason = (typeof importErrorReasons)[number];

/** A file refused as a whole (`IO-013`): nothing of it is imported. */
export class ImportError extends Error {
  constructor(
    readonly reason: ImportErrorReason,
    readonly detail: string,
  ) {
    super(`${reason}: ${detail}`);
  }
}
