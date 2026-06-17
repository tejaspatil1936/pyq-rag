import path from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // Match tsconfig's "@/*" so route handlers import cleanly in tests.
    alias: { "@": path.dirname(fileURLToPath(import.meta.url)) },
  },
  test: {
    setupFiles: ["tests/setup.ts"],
    // First embedding test downloads the ONNX model (~23 MB); DB tests cross
    // the ocean to Neon. Generous timeouts keep CI stable.
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
