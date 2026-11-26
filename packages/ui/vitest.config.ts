import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    ...(process.env["CI"] ? {} : { maxWorkers: "50%" }),
  },
});
