import { defineConfig } from "astro/config";
import tailwindcss from "@tailwindcss/vite";
import sitemap from "@astrojs/sitemap";

import { published, posts } from "./src/content/posts.ts";
import { publishedVersion } from "./src/content/published.ts";

const shown = new Set(published(await publishedVersion()).map((p) => p.slug));
const heldBack = posts.filter((p) => !shown.has(p.slug)).map((p) => `/blog/${p.slug}`);

export default defineConfig({
  site: "https://pikos.app",
  output: "static",
  integrations: [
    sitemap({
      filter: (page) => !heldBack.some((path) => new URL(page).pathname.startsWith(path)),
    }),
  ],
  vite: {
    plugins: [tailwindcss()],
  },
  build: {
    assets: "_assets",
  },
});
