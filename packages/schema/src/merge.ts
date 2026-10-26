import type { InferSelectModel } from "drizzle-orm";
import type { JournaledTable } from "./enums.ts";
import type { journaled } from "./schema.ts";

type Row<T extends JournaledTable> = InferSelectModel<(typeof journaled)[T]>;
type Column<T extends JournaledTable> = Extract<keyof Row<T>, string>;

export interface KeyPart<T extends JournaledTable> {
  readonly column: Column<T>;
  readonly normalize: "exact" | "lower";
}

export interface Owner<T extends JournaledTable> {
  readonly parent: JournaledTable;
  readonly via: Column<T>;
}

export interface UniqueResolution<T extends JournaledTable> {
  readonly index: string;
  readonly patchIncoming: (incoming: Row<T>, local: Row<T>) => Partial<Row<T>>;
}

// Rows are matched by id first; natural_key and day_singleton keys only apply when the incoming id is unknown locally. Owned rows always travel with the winning version of their parent.
export type MergePolicy<T extends JournaledTable> =
  | { readonly kind: "newest"; readonly unique: readonly UniqueResolution<T>[] }
  | { readonly kind: "immutable" }
  | { readonly kind: "owned"; readonly owners: readonly [Owner<T>, ...Owner<T>[]] }
  | { readonly kind: "natural_key"; readonly key: readonly KeyPart<T>[] }
  | { readonly kind: "day_singleton"; readonly columns: readonly Column<T>[] }
  | { readonly kind: "renumber"; readonly lineage: Column<T>; readonly number: Column<T>; readonly orderBy: Column<T> };

export const mergePolicies: { readonly [T in JournaledTable]: MergePolicy<T> } = {
  sport_preference: { kind: "newest", unique: [] },
  gear: { kind: "newest", unique: [] },
  exercise: { kind: "natural_key", key: [{ column: "nameKey", normalize: "exact" }] },
  exercise_zone: { kind: "owned", owners: [{ parent: "exercise", via: "exerciseId" }] },
  measurement_kind: { kind: "natural_key", key: [{ column: "label", normalize: "lower" }] },
  program: { kind: "newest", unique: [{ index: "program_single_active", patchIncoming: () => ({ status: "archived" }) }] },
  program_version: { kind: "renumber", lineage: "programId", number: "number", orderBy: "createdAt" },
  program_slot: { kind: "owned", owners: [{ parent: "program_version", via: "versionId" }] },
  program_variant: { kind: "owned", owners: [{ parent: "program_slot", via: "slotId" }] },
  program_item: { kind: "owned", owners: [{ parent: "program_variant", via: "variantId" }] },
  rotation_skip: { kind: "immutable" },
  session: {
    kind: "newest",
    unique: [{ index: "session_single_open", patchIncoming: (incoming) => ({ status: "completed", endedAt: incoming.endedAt ?? incoming.updatedAt }) }],
  },
  strength_entry: { kind: "owned", owners: [{ parent: "session", via: "sessionId" }] },
  strength_set: { kind: "owned", owners: [{ parent: "strength_entry", via: "entryId" }] },
  session_item: { kind: "owned", owners: [{ parent: "session", via: "sessionId" }] },
  weigh_in: { kind: "day_singleton", columns: ["localDate"] },
  measurement: { kind: "day_singleton", columns: ["kindId", "localDate"] },
  photo: { kind: "newest", unique: [] },
  check_in: { kind: "day_singleton", columns: ["localDate"] },
  pain_report: { kind: "owned", owners: [{ parent: "session", via: "sessionId" }, { parent: "check_in", via: "checkInId" }] },
  zone_tracking: { kind: "newest", unique: [{ index: "zone_tracking_open", patchIncoming: (incoming, local) => ({ endedAt: incoming.startedAt > local.startedAt ? incoming.startedAt : local.startedAt }) }] },
};
