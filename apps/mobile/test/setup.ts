import { beforeEach } from "vitest";
import { resetDatabase } from "./mocks/database.ts";
import { resetFileSystem } from "./mocks/expoFileSystem.ts";
import { secureItems } from "./mocks/expoSecureStore.ts";

export const reportedErrors: unknown[] = [];

Object.assign(globalThis, {
  ErrorUtils: {
    getGlobalHandler: () => (error: unknown) => {
      reportedErrors.push(error);
    },
  },
});

beforeEach(() => {
  resetDatabase();
  secureItems.clear();
  resetFileSystem();
  reportedErrors.length = 0;
});
