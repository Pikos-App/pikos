import { defineConfig } from "vitest/config";

// Pinned so wall-clock logic expands identically across machines and CI.
process.env["TZ"] = "UTC";

export default defineConfig({
  test: {
    ...(process.env["CI"] ? {} : { maxWorkers: "50%" }),
    environment: "jsdom",
    // The conformance tables are read off disk, outside vitest's module graph, so `--changed`
    // selects nothing when one is edited. `cargo test` runs everything, so the Rust runners catch a
    // break, while this half would stay quiet until CI. Vitest replaces the default list rather
    // than extending it, so the defaults are repeated.
    forceRerunTriggers: [
      "**/package.json/**",
      "**/{vitest,vite}.config.*/**",
      "**/crates/pikos-db/tests/fixtures/**",
      "**/crates/pikos-recurrence/tests/fixtures/**",
    ],
    coverage: {
      provider: "v8",
      reporter: ["text-summary", "html", "json-summary"],
      include: ["src/**/*.ts"],
      exclude: [
        "src/**/*.test.ts",
        // Pure type modules: no executable lines.
        "src/types.ts",
        "src/storage.ts",
        "src/index.ts",
        "src/import/types.ts",
      ],
      // Per-directory thresholds, just under current baselines. Bump as coverage grows so a
      // regression trips CI without normal churn doing so.
      thresholds: {
        "src/nlp/**": { lines: 95, branches: 88, functions: 95, statements: 95 },
        "src/utils/**": { lines: 85, branches: 80, functions: 90, statements: 85 },
        "src/adapters/**": { lines: 70, branches: 65, functions: 65, statements: 70 },
        "src/calendar/**": { lines: 90, branches: 85, functions: 90, statements: 90 },
        "src/constants/**": { lines: 95, branches: 90, functions: 95, statements: 95 },
        "src/format/**": { lines: 95, branches: 90, functions: 95, statements: 95 },
        "src/import/**": { lines: 95, branches: 90, functions: 95, statements: 95 },
        "src/layout/**": { lines: 95, branches: 90, functions: 95, statements: 95 },
        "src/pages/**": { lines: 90, branches: 80, functions: 90, statements: 90 },
        "src/sync/**": { lines: 95, branches: 90, functions: 95, statements: 95 },
      },
    },
  },
});
