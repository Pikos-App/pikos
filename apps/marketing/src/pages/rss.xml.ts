import rss from "@astrojs/rss";
import type { APIContext } from "astro";

// Keep in sync with /src/pages/blog/index.astro
const posts = [
  {
    slug: "what-if-pikos-goes-away",
    title: "What If Pikos Goes Away?",
    description:
      "Your data is a file on your computer. The app works without a server. Here's what that means for longevity.",
    date: "2026-04-17",
  },
  {
    slug: "why-a-native-app",
    title: "Why a Native App",
    description:
      "You could use a browser tab. Here's why a dedicated app is better for the things you use every day.",
    date: "2026-04-15",
  },
  {
    slug: "nothing-to-hack",
    title: "Nothing to Hack",
    description:
      "No servers, no databases, no user accounts. The best security is having almost nothing to protect.",
    date: "2026-04-13",
  },
  {
    slug: "backups-are-on-you",
    title: "Backups Are on You",
    description:
      "There's no account, no server, and no way for us to recover your data. Here's how to protect it.",
    date: "2026-04-11",
  },
  {
    slug: "the-code-is-public",
    title: "The Code Is Public",
    description:
      "The Pikos codebase is now source-available. What you can do with it, how it's licensed, and why it matters for trust.",
    date: "2026-04-09",
  },
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
    description: "No subscription to use the app. You pay once, you own it.",
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
