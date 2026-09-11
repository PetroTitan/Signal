import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  // Match Next's automatic JSX runtime so components can be imported +
  // rendered in tests without an explicit `import React`.
  esbuild: {
    jsx: "automatic",
    jsxImportSource: "react",
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "server-only": path.resolve(__dirname, "./src/test/server-only-shim.ts"),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // The real-Postgres suites boot a WASM Postgres and replay all 37
    // migrations per file, so they need more than the 5s default.
    testTimeout: 30_000,
    hookTimeout: 180_000,
  },
});
