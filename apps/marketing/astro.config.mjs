import { defineConfig } from "astro/config";
import tailwindcss from "@tailwindcss/vite";
import sitemap from "@astrojs/sitemap";

export default defineConfig({
  site: "https://pikos.app",
  output: "static",
  integrations: [sitemap()],
  vite: {
    plugins: [tailwindcss()],
    build: {
      // Vite's default target strips -webkit-backdrop-filter, which Safari before 18 needs for the blur.
      cssTarget: "safari16",
    },
  },
  build: {
    assets: "_assets",
  },
});
