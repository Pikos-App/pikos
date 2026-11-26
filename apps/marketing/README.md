# @pikos/marketing

The [pikos.app](https://pikos.app) website. A static Astro site with Tailwind CSS, deployed to Cloudflare Pages.

```bash
pnpm dev:marketing    # from the repository root
```

Pages are in `src/pages/`, shared layouts and components in `src/layouts/` and `src/components/`, and static assets in `public/`.

## Adding a blog post

Follow the steps in `src/pages/blog/_template.astro`. A post's title, description, date, and tag live in `src/content/posts.ts` and nowhere else, so the listing, the page, and the RSS feed can't disagree.
