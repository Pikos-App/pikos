import rss from "@astrojs/rss";
import type { APIContext } from "astro";

// Keep in sync with /src/pages/blog/index.astro
const posts = [
  {
    slug: "your-calendar-inside-pikos",
    title: "Your Calendar, Inside Pikos",
    description:
      "Pikos 0.4.0 syncs your calendar in: iCloud, Google, or any CalDAV server. Read-only, opt-in, and your notes stay on your device.",
    date: "2026-09-20",
  },
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

/** Posts dated on or before the day the site is built.
 *
 *  A date ahead of the build is a scheduled post, not a published one, so it stays
 *  out of the feed until a build runs on or after that day. Nothing reads the clock
 *  at request time — this is a static site, so shipping a post on its date needs a
 *  build on its date. */
function published<T extends { date: string }>(all: T[]): T[] {
  const today = new Date().toISOString().slice(0, 10);
  return all.filter((p) => p.date <= today);
}

export function GET(context: APIContext) {
  return rss({
    title: "Pikos Blog",
    description: "Articles about Pikos: the app, the architecture, the philosophy.",
    site: context.site!.toString(),
    items: published(posts).map((post) => ({
      title: post.title,
      description: post.description,
      pubDate: new Date(post.date),
      link: `/blog/${post.slug}`,
    })),
  });
}
