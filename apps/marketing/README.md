# @pkos/marketing

The [pikos.app](https://pikos.app) website. Static site built with Astro and Tailwind CSS, deployed to Cloudflare Pages.

## Development

From the repository root:

```bash
pnpm dev:marketing
```

Or directly:

```bash
cd apps/marketing
pnpm dev
```

## Structure

```
src/
  pages/          — Astro pages (/, /blog, /download, /open, /privacy, /terms, /release-notes)
  layouts/        — Base and BlogPost layouts
  components/     — Nav, Footer
  styles/         — Global CSS (Tailwind)
public/           — Static assets (videos, images, favicon)
```

## Adding a blog post

1. Copy `src/pages/blog/_template.astro` to `src/pages/blog/your-slug.astro`
2. Fill in props (title, description, date) and write the content
3. Add an entry to the `posts` array in `src/pages/blog/index.astro`
4. Add a matching entry in `src/pages/rss.xml.ts`
