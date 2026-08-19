import { defineConfig } from "vitest/config";

// Pin a deterministic timezone so wall-clock-sensitive logic expands identically
// across machines and CI.
process.env["TZ"] = "UTC";

export default defineConfig({
  test: {
    ...(process.env["CI"] ? {} : { maxWorkers: "50%" }),
    environment: "jsdom",
    coverage: {
      provider: "v8",
      reporter: ["text-summary", "html", "json-summary"],
      include: ["src/**/*.ts"],
      exclude: [
        "src/**/*.test.ts",
        // Pure type/interface modules — no executable lines to cover.
        "src/types.ts",
        "src/storage.ts",
        "src/index.ts",
        "src/import/types.ts",
      ],
      // Per-directory thresholds set just under current baselines. Bump as
      // coverage grows so regressions trip CI without normal churn doing so.
      //
      // The calendar/constants/format/import/layout/pages/sync entries carry
      // over the bars these modules met while they lived in apps/desktop, so
      // moving them into core did not quietly relax anything.
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
