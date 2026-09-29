import { readFileSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";

import babel from "@rolldown/plugin-babel";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const host = process.env["TAURI_DEV_HOST"];
const pkg = JSON.parse(readFileSync("./package.json", "utf-8")) as { version: string };

export default defineConfig({
  clearScreen: false,
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  // The compiler is a separate plugin, not an option on react(). plugin-react v6
  // dropped its `babel` key, and an unknown key there is ignored rather than
  // rejected — which is how this config ran with the compiler silently off.
  plugins: [react(), babel({ presets: [reactCompilerPreset()] })],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      // Dev/test fixtures live outside src so a grep (or an agent reading the
      // tree) doesn't pay for ~4k lines of seed data on every pass through the
      // app source. They are still bundled — lazily, via seedLoaders — so the
      // alias has to resolve for `vite build` as well as dev.
      "@seeds": fileURLToPath(new URL("./seeds", import.meta.url)),
    },
  },
  server: {
    // Spread rather than `: undefined` — exactOptionalPropertyTypes rejects an
    // explicit undefined where the option is simply absent.
    ...(host ? { hmr: { host, port: 1422, protocol: "ws" as const } } : {}),
    host: host || false,
    port: 1420,
    strictPort: true,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
});
