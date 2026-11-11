import { defineCollection, z } from "astro:content";
import { glob } from "astro/loaders";

/**
 * One file per version, named for it, and the only place a release's notes are written: the
 * site renders every file, and the release workflow sends the tagged version's body to GitHub and
 * the in-app update dialog. The id is the bare filename because the default slugger drops the
 * dots, turning 0.4.1 into 041.
 */
const releaseNotes = defineCollection({
  loader: glob({
    base: "./src/content/release-notes",
    generateId: ({ entry }) => entry.replace(/\.md$/, ""),
    pattern: "*.md",
  }),
  schema: z.object({
    badge: z.string().optional(),
    date: z.coerce.date(),
  }),
});

export const collections = { releaseNotes };
