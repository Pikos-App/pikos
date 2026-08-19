import { defineConfig } from "vitest/config";

// Tokens are pure data — no DOM, no timers, so the default node environment is
// all this package needs.
export default defineConfig({
  test: {
    ...(process.env["CI"] ? {} : { maxWorkers: "50%" }),
  },
});
