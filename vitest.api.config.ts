import { defineConfig } from "vitest/config";

// Black-box suite: hits a RUNNING server over HTTP (localhost:3000 by
// default, or API_BASE_URL for a deployed instance). Run with npm run
// test:api. Kept out of the main `npm test` config, which tests the code
// directly against the database.
export default defineConfig({
  test: {
    include: ["tests/api/**/*.test.ts"],
    // Cold starts: the server may download the embedding model on the first
    // semantic/topic request, plus live Gemini calls.
    testTimeout: 120_000,
    hookTimeout: 60_000,
  },
});
