import { beforeEach } from "vitest";
import { resetDatabase } from "./mocks/database.ts";
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
  reportedErrors.length = 0;
});
