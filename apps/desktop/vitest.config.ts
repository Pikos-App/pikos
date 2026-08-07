import { fileURLToPath, URL } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// Pin a deterministic timezone so wall-clock-sensitive logic expands identically
// across machines and CI.
process.env["TZ"] = "UTC";

export default defineConfig({
  plugins: [
    react({
      babel: {
        plugins: [["babel-plugin-react-compiler", {}]],
      },
    }),
  ],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    // Vitest sizes its worker pool from the core count, but it never has the box
    // to itself here: `pnpm verify` fans out two packages' suites plus lint,
    // depcruise and two tsc passes at once, which together peg every core and
    // leave the machine unusable while it runs. Cap the local share; CI does get
    // the box to itself, so it keeps the default.
    ...(process.env["CI"] ? {} : { maxWorkers: "50%" }),
    coverage: {
      exclude: [
        "src/**/*.test.{ts,tsx}",
        "src/test/**",
        "src/**/*.d.ts",
        // Adapter is exercised via @pikos/core MockStorageAdapter tests.
        "src/lib/adapters/**",
        // Seeds and screenshots/scripts are dev/marketing-only utilities.
        "src/shared/seeds/**",
        "src/main.tsx",
        "src/vite-env.d.ts",
      ],
      include: ["src/**/*.{ts,tsx}"],
      provider: "v8",
      reporter: ["text-summary", "html", "json-summary"],
      // Per-directory thresholds on the load-bearing pure-logic dirs (hooks,
      // context, utils, parsers). Components and feature UI surfaces are 0% by
      // design here — they're covered by Playwright E2E, which v8 doesn't see.
      // Numbers sit just under current to allow normal churn but trip on real
      // regressions. Aggregate global thresholds intentionally omitted: a single
      // average across tested + E2E-only files is a false signal.
      thresholds: {
        "src/features/calendar/utils/**": {
          branches: 85,
          functions: 90,
          lines: 90,
          statements: 90,
        },
        "src/features/folders/hooks/**": { branches: 80, functions: 90, lines: 90, statements: 90 },
        "src/features/import/parsers/**": {
          branches: 90,
          functions: 95,
          lines: 95,
          statements: 95,
        },
        "src/features/layout/hooks/**": { branches: 50, functions: 70, lines: 70, statements: 65 },
        "src/features/layout/utils/**": { branches: 90, functions: 95, lines: 95, statements: 95 },
        "src/features/pages/hooks/**": { branches: 75, functions: 85, lines: 85, statements: 85 },
        "src/features/pages/utils/**": { branches: 70, functions: 85, lines: 85, statements: 85 },
        "src/shared/context/**": { branches: 55, functions: 80, lines: 70, statements: 70 },
        "src/shared/events/**": { branches: 45, functions: 90, lines: 90, statements: 90 },
        "src/shared/keyboard/**": { branches: 70, functions: 55, lines: 70, statements: 70 },
        "src/shared/utils/**": { branches: 90, functions: 95, lines: 95, statements: 95 },
      },
    },
    env: {
      // Routes adapters/logger/import paths to the test-mode branches so every
      // test file gets MockStorageAdapter without stubbing the env per-file.
      VITE_TEST_MODE: "true",
    },
    environment: "jsdom",
    include: ["src/**/*.test.{ts,tsx}"],
    setupFiles: ["./src/test/setup.ts"],
  },
});
