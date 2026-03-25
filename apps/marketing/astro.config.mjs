import { defineConfig } from "astro/config";
import tailwindcss from "@tailwindcss/vite";
import sitemap from "@astrojs/sitemap";
import node from "@astrojs/node";

export default defineConfig({
  site: "https://pikos.app",
  adapter: node({ mode: "standalone" }),
  integrations: [sitemap()],
  vite: {
    plugins: [tailwindcss()],
  },
  build: {
    assets: "_assets",
  },
});
