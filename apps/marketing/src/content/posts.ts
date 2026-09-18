/**
 * Every blog post's metadata, written once.
 *
 * The title, description and date used to be repeated in three places: this list's ancestor in
 * `blog/index.astro`, a second copy in `rss.xml.ts`, and the post file's own `<BlogPost>` props.
 * Nothing failed when one was missed, so a post could be filed under one date in the feed and
 * another on the site, and RSS readers sort by the feed. `BlogPost.astro` now takes a slug and
 * reads the rest from here, so a post file carries no metadata at all.
 *
 * Newest first. The order is the order the listing renders in.
 */
export interface Post {
  slug: string;
  title: string;
  description: string;
  /** ISO date. A date ahead of the build schedules the post; see `published`. */
  date: string;
  tag: string;
}

export const posts: Post[] = [
  {
    slug: "your-calendar-inside-pikos",
    title: "Your Calendar, Inside Pikos",
    description:
      "Pikos 0.4.0 syncs your calendar in: iCloud, Google, or any CalDAV server. Read-only, opt-in, and your notes stay on your device.",
    date: "2026-09-20",
    tag: "Features",
  },
  {
    slug: "the-code-is-public",
    title: "The Code Is Public",
    description:
      "The Pikos codebase is now source-available. What you can do with it, how it's licensed, and why it matters for trust.",
    date: "2026-06-10",
    tag: "Transparency",
  },
  {
    slug: "what-if-pikos-goes-away",
    title: "What If Pikos Goes Away?",
    description:
      "Your data is a file on your computer. The app works without a server. Here's what that means for longevity.",
    date: "2026-06-10",
    tag: "Philosophy",
  },
  {
    slug: "buy-once",
    title: "Buy Once",
    description:
      "No subscription, now or ever. The desktop app is free. The paid versions will be one-time purchases.",
    date: "2026-06-10",
    tag: "Pricing",
  },
  {
    slug: "your-data-stays-on-your-device",
    title: "Your Data Stays on Your Device",
    description: "Pikos doesn't have accounts, servers, or access to your data. Here's why.",
    date: "2026-05-09",
    tag: "Privacy",
  },
];

/**
 * A date ahead of the build is a scheduled post, not a published one, so it stays out of the
 * listing and the feed until a build runs on or after that day. Nothing reads the clock at request
 * time: this is a static site, so shipping a post on its date needs a build on its date.
 */
export function published(all: Post[] = posts): Post[] {
  const today = new Date().toISOString().slice(0, 10);
  return all.filter((p) => p.date <= today);
}

/**
 * Renders an ISO date for display, in the date's own terms rather than the builder's timezone.
 *
 * `new Date("2026-06-10")` is parsed as UTC midnight, and `toLocaleDateString` then prints it in
 * local time, so every post built anywhere west of UTC showed the day before its own date. The
 * page said June 9 while its `datetime` attribute and JSON-LD both said the 10th. Splitting the
 * string and using the local-time constructor keeps the date the one that was written down.
 */
export function formatDate(date: string): string {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(year, month - 1, day).toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

/**
 * Throws rather than rendering a post with a blank title, because a silently empty `<h1>` is the
 * failure this file exists to prevent. A slug typo fails the build instead of shipping.
 */
export function postBySlug(slug: string): Post {
  const post = posts.find((p) => p.slug === slug);
  if (!post) {
    throw new Error(
      `No post with slug "${slug}" in src/content/posts.ts. Add it there rather than passing metadata to BlogPost.`
    );
  }
  return post;
}
