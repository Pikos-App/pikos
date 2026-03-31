import rss from "@astrojs/rss";
import type { APIContext } from "astro";

// Keep in sync with /src/pages/blog/index.astro
const posts = [
  {
    slug: "getting-started",
    title: "Getting Started with Pikos",
    description: "A quick look at what happens when you open Pikos for the first time.",
    date: "2026-04-07",
  },
  {
    slug: "one-app-instead-of-three",
    title: "One App Instead of Three",
    description: "Notes, tasks, and calendar belong together. Pikos puts them in one place.",
    date: "2026-04-05",
  },
  {
    slug: "buy-once",
    title: "Buy Once",
    description: "No subscription. No recurring charge. You pay once, you own it.",
    date: "2026-04-03",
  },
  {
    slug: "your-data-stays-on-your-device",
    title: "Your Data Stays on Your Device",
    description:
      "Pikos doesn't have accounts, servers, or access to your data. Here's why.",
    date: "2026-04-01",
  },
];

export function GET(context: APIContext) {
  return rss({
    title: "Pikos Blog",
    description: "Articles about Pikos — the app, the architecture, the philosophy.",
    site: context.site!.toString(),
    items: posts.map((post) => ({
      title: post.title,
      description: post.description,
      pubDate: new Date(post.date),
      link: `/blog/${post.slug}`,
    })),
  });
}
