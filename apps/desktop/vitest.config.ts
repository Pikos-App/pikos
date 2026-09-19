import { fileURLToPath, URL } from "node:url";

import babel from "@rolldown/plugin-babel";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// Pin a deterministic timezone so wall-clock-sensitive logic expands identically
// across machines and CI.
process.env["TZ"] = "UTC";

export default defineConfig({
  // Tests run the compiled components for the same reason production does; the
  // shape of this is explained in vite.config.ts.
  plugins: [react(), babel({ presets: [reactCompilerPreset()] })],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      // Mirrors vite.config.ts — the seed fixtures live in apps/desktop/seeds,
      // outside the app source.
      "@seeds": fileURLToPath(new URL("./seeds", import.meta.url)),
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
        // Screenshots/scripts are dev/marketing-only utilities. (The seed
        // fixtures used to need an entry here too; they now live in
        // apps/desktop/seeds, which `include` below never reaches.)
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
    // The conformance tables are read off disk with `node:fs`, so they are not in
    // vitest's module graph and `--changed` selects nothing when one is edited. The
    // Rust runners catch a break because `cargo test` runs everything; this side
    // would stay quiet until CI, which is the half of a two-sided table that matters.
    // Vitest replaces the default list rather than extending it, so the defaults are
    // repeated here.
    forceRerunTriggers: [
      "**/package.json/**",
      "**/{vitest,vite}.config.*/**",
      "**/crates/pikos-db/tests/fixtures/**",
      "**/crates/pikos-recurrence/tests/fixtures/**",
    ],
    // seeds/ carries two suites of its own — the tutorial seed's unit test and
    // the synced-calendar conformance runner — so it has to be swept too.
    include: ["src/**/*.test.{ts,tsx}", "seeds/**/*.test.{ts,tsx}"],
    setupFiles: ["./src/test/setup.ts"],
  },
});
