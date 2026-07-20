import { defineConfig } from "vitest/config";

// Cross-subject eval battery against a RUNNING server:
//   SUBJECTS="A,B,C" npm run test:subjects
// Sequential by design — it hammers Gemini enough as it is.
export default defineConfig({
  test: {
    include: ["tests/battery/**/*.test.ts"],
    testTimeout: 180_000,
    hookTimeout: 120_000,
    maxWorkers: 1,
    minWorkers: 1,
  },
});
