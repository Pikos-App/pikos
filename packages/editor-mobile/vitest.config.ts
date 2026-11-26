import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    // e2e/ is Playwright's; vitest would fail on its hooks.
    exclude: ["node_modules/**", "dist/**", "e2e/**"],
  },
});
