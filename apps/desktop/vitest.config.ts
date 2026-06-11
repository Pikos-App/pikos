import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

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
    environment: "jsdom",
    env: {
      // Routes adapters/logger/import paths to the test-mode branches so every
      // test file gets MockStorageAdapter without stubbing the env per-file.
      VITE_TEST_MODE: "true",
    },
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
    coverage: {
      provider: "v8",
      reporter: ["text-summary", "html", "json-summary"],
      include: ["src/**/*.{ts,tsx}"],
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
      // Per-directory thresholds on the load-bearing pure-logic dirs (hooks,
      // context, utils, parsers). Components and feature UI surfaces are 0% by
      // design here — they're covered by Playwright E2E, which v8 doesn't see.
      // Numbers sit just under current to allow normal churn but trip on real
      // regressions. Aggregate global thresholds intentionally omitted: a single
      // average across tested + E2E-only files is a false signal.
      thresholds: {
        "src/features/calendar/utils/**": { lines: 90, branches: 85, functions: 90, statements: 90 },
        "src/features/folders/hooks/**": { lines: 90, branches: 80, functions: 90, statements: 90 },
        "src/features/import/parsers/**": { lines: 95, branches: 90, functions: 95, statements: 95 },
        "src/features/layout/hooks/**": { lines: 70, branches: 50, functions: 70, statements: 65 },
        "src/features/layout/utils/**": { lines: 95, branches: 90, functions: 95, statements: 95 },
        "src/features/pages/hooks/**": { lines: 85, branches: 75, functions: 85, statements: 85 },
        "src/features/pages/utils/**": { lines: 85, branches: 70, functions: 85, statements: 85 },
        "src/shared/context/**": { lines: 70, branches: 55, functions: 80, statements: 70 },
        "src/shared/events/**": { lines: 90, branches: 45, functions: 90, statements: 90 },
        "src/shared/keyboard/**": { lines: 70, branches: 70, functions: 55, statements: 70 },
        "src/shared/utils/**": { lines: 95, branches: 90, functions: 95, statements: 95 },
      },
    },
  },
});
