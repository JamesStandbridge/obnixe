import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

function local(path: string): string {
  return fileURLToPath(new URL(path, import.meta.url));
}

export default defineConfig({
  resolve: {
    alias: [
      { find: /^@\/data\/database$/, replacement: local("./test/mocks/database.ts") },
      { find: /^@\//, replacement: `${local("./src")}/` },
      { find: /^react-native$/, replacement: local("./test/mocks/reactNative.ts") },
      { find: /^expo-crypto$/, replacement: local("./test/mocks/expoCrypto.ts") },
      { find: /^expo-secure-store$/, replacement: local("./test/mocks/expoSecureStore.ts") },
    ],
  },
  test: {
    include: ["src/**/*.test.ts"],
    setupFiles: ["./test/setup.ts"],
  },
});
