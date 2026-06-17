import { defineConfig } from "vitest/config";

// Pin a deterministic timezone so wall-clock-sensitive logic expands identically
// across machines and CI.
process.env["TZ"] = "UTC";

export default defineConfig({
  test: {
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
      ],
      // Per-directory thresholds set just under current baselines. Bump as
      // coverage grows so regressions trip CI without normal churn doing so.
      thresholds: {
        "src/nlp/**": { lines: 95, branches: 88, functions: 95, statements: 95 },
        "src/utils/**": { lines: 85, branches: 80, functions: 90, statements: 85 },
        "src/adapters/**": { lines: 70, branches: 65, functions: 65, statements: 70 },
      },
    },
  },
});
