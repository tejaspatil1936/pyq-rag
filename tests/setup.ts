import { config } from "dotenv";

config(); // load .env for local runs; CI injects secrets directly

// In CI a missing secret must fail loudly, never silently skip everything.
if (process.env.CI && !process.env.DATABASE_URL) {
  throw new Error("CI run without DATABASE_URL — add the repo secret to the workflow");
}

if (!process.env.DATABASE_URL) {
  console.warn(
    "DATABASE_URL not set — database integration tests will be SKIPPED. " +
      "Create .env (see .env.example) to run them.",
  );
}

export const hasDb = Boolean(process.env.DATABASE_URL);
