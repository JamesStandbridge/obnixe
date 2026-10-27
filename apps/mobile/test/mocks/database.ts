import { randomFillSync } from "node:crypto";
import type { Environment, ObnixeDatabase } from "@obnixe/core";
import { createTestContext } from "@obnixe/core/testing";
import { createIdFactory } from "@obnixe/schema";
import type { EpochMs } from "@obnixe/schema";

let current: ObnixeDatabase = createTestContext().db;

export function resetDatabase(): void {
  current = createTestContext().db;
}

export function db(): ObnixeDatabase {
  return current;
}

export const environment: Environment = {
  now: () => Date.now() as EpochMs,
  newId: createIdFactory(randomFillSync, Date.now),
};
