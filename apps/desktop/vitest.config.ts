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
    // Local runs share the machine with the rest of `pnpm verify`; CI doesn't.
    ...(process.env["CI"] ? {} : { maxWorkers: "50%" }),
    coverage: {
      exclude: [
        "src/**/*.test.{ts,tsx}",
        "src/test/**",
        "src/**/*.d.ts",
        // Seeds and screenshots/scripts are dev/marketing-only utilities.
        "src/shared/seeds/**",
        "src/main.tsx",
        "src/vite-env.d.ts",
      ],
      include: ["src/**/*.{ts,tsx}"],
      provider: "v8",
      reporter: ["text-summary", "html", "json-summary"],
      // Per-directory rather than global: UI dirs are covered by Playwright,
      // which v8 can't see, so one average would read them as untested.
      thresholds: {
        "src/features/calendar/utils/**": {
          branches: 85,
          functions: 90,
          lines: 90,
          statements: 90,
        },
        "src/features/folders/hooks/**": { branches: 80, functions: 90, lines: 90, statements: 90 },
        "src/features/layout/hooks/**": { branches: 50, functions: 70, lines: 70, statements: 65 },
        "src/features/pages/hooks/**": { branches: 75, functions: 85, lines: 85, statements: 85 },
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
