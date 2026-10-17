import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    // e2e/ is Playwright's, and its specs use test.beforeEach from a different
    // runner. Without this, `pnpm test` discovers them and fails on the first
    // hook it does not recognise.
    exclude: ["node_modules/**", "dist/**", "e2e/**"],
  },
});
