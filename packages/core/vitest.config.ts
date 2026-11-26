import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    testTimeout: 30_000,
    coverage: {
      provider: "v8",
      include: ["src/tracking/**/*.ts"],
      exclude: ["src/tracking/**/*.test.ts"],
      reporter: ["text-summary", "json"],
      thresholds: { lines: 90 },
    },
  },
});
