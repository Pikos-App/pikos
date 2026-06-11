import rss from "@astrojs/rss";
import type { APIContext } from "astro";

// Keep in sync with /src/pages/blog/index.astro
const posts = [
  {
    slug: "the-code-is-public",
    title: "The Code Is Public",
    description:
      "The Pikos codebase is now source-available. What you can do with it, how it's licensed, and why it matters for trust.",
    date: "2026-06-10",
  },
  {
    slug: "what-if-pikos-goes-away",
    title: "What If Pikos Goes Away?",
    description:
      "Your data is a file on your computer. The app works without a server. Here's what that means for longevity.",
    date: "2026-06-10",
  },
  {
    slug: "buy-once",
    title: "Buy Once",
    description: "No subscription, now or ever. The desktop app is free. The paid versions will be one-time purchases.",
    date: "2026-06-10",
  },
  {
    slug: "your-data-stays-on-your-device",
    title: "Your Data Stays on Your Device",
    description:
      "Pikos doesn't have accounts, servers, or access to your data. Here's why.",
    date: "2026-05-09",
  },
];

export function GET(context: APIContext) {
  return rss({
    title: "Pikos Blog",
    description: "Articles about Pikos: the app, the architecture, the philosophy.",
    site: context.site!.toString(),
    items: posts.map((post) => ({
      title: post.title,
      description: post.description,
      pubDate: new Date(post.date),
      link: `/blog/${post.slug}`,
    })),
  });
}
