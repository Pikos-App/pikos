import { resolve } from "node:path";

import { createServer } from "vite";
import { describe, expect, it } from "vitest";

import { EmptyState } from "@/shared/components/EmptyState";

function readsMemoCache(code: string | undefined) {
  return code?.includes("$[0]") ?? false;
}

describe("the React Compiler", () => {
  it("compiles components in the unit tests", () => {
    expect(readsMemoCache(EmptyState.toString())).toBe(true);
  });

  it("compiles components in the app build", async () => {
    const root = process.cwd();
    const server = await createServer({
      configFile: resolve(root, "vite.config.ts"),
      logLevel: "silent",
      optimizeDeps: { noDiscovery: true },
      root,
      server: { hmr: false, middlewareMode: true, watch: null },
    });

    try {
      const result = await server.transformRequest("/src/shared/components/EmptyState.tsx");

      expect(readsMemoCache(result?.code)).toBe(true);
    } finally {
      await server.close();
    }
  });
});
