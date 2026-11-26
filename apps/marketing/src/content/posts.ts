import { isOut } from "./published";

/**
 * Every blog post's metadata, written once. The listing, the RSS feed and `BlogPost.astro`
 * all read it, so a post can't carry one date in the feed and another on the site. Newest
 * first, which is the listing's order.
 */
export interface Post {
  slug: string;
  title: string;
  description: string;
  /** ISO date. A date ahead of the build schedules the post; see `published`. */
  date: string;
  tag: string;
  /** The release a post announces, which holds it back until that release is published. */
  version?: string;
}

export const posts: Post[] = [
  {
    slug: "fast-at-any-size",
    title: "Fast at any size",
    description:
      "Pikos 0.4.1 opens a page in under a tenth of a second with fifty pages or half a million. What changed, how it stays that way, and how to check it yourself.",
    date: "2026-10-14",
    tag: "Releases",
    version: "0.4.1",
  },
  {
    slug: "your-calendar-inside-pikos",
    title: "Your calendar, inside Pikos",
    description:
      "Pikos 0.4.0 syncs your calendar in: Google, iCloud, or any CalDAV server. Read-only, opt-in, and your notes stay on your device.",
    date: "2026-09-28",
    tag: "Releases",
    version: "0.4.0",
  },
  {
    slug: "the-code-is-public",
    title: "The code is public",
    description:
      "You can read every line of Pikos and check the privacy claims yourself, instead of taking my word for them.",
    date: "2026-06-10",
    tag: "Principles",
  },
  {
    slug: "what-if-pikos-goes-away",
    title: "What if Pikos goes away?",
    description:
      "Your data is a file on your computer. The app works without a server. Here's what that means for longevity.",
    date: "2026-06-10",
    tag: "Principles",
  },
  {
    slug: "buy-once",
    title: "Buy once",
    description:
      "No subscription, now or ever. The desktop app is free. The paid versions will be one-time purchases.",
    date: "2026-06-10",
    tag: "Principles",
  },
  {
    slug: "your-data-stays-on-your-device",
    title: "Your data stays on your device",
    description: "Pikos doesn't have accounts, servers, or access to your data. Here's why.",
    date: "2026-05-09",
    tag: "Principles",
  },
];

/**
 * A date ahead of the build is a scheduled post and stays out of the listing and feed until a
 * build runs on or after that day, since a static site never reads the clock at request time. A
 * post announcing a release newer than `releasedVersion` waits the same way.
 */
export function published(releasedVersion: string, all: Post[] = posts): Post[] {
  const today = new Date().toISOString().slice(0, 10);
  return all.filter((p) => p.date <= today && (!p.version || isOut(p.version, releasedVersion)));
}

/**
 * Renders an ISO date in its own terms, not the builder's timezone: `new Date("2026-06-10")`
 * is UTC midnight, which prints as the day before anywhere west of UTC. Splitting the string
 * and using the local-time constructor keeps the written date.
 */
export function formatDate(date: string): string {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(year, month - 1, day).toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

/** Throws on an unknown slug, so a typo fails the build instead of shipping an empty `<h1>`. */
export function postBySlug(slug: string): Post {
  const post = posts.find((p) => p.slug === slug);
  if (!post) {
    throw new Error(
      `No post with slug "${slug}" in src/content/posts.ts. Add it there rather than passing metadata to BlogPost.`
    );
  }
  return post;
}
