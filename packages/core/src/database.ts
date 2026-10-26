import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import type { EpochMs, Id, schema } from "@obnixe/schema";

export type ObnixeDatabase = BaseSQLiteDatabase<"sync", unknown, typeof schema>;

export interface Environment {
  readonly now: () => EpochMs;
  readonly newId: () => Id;
}
