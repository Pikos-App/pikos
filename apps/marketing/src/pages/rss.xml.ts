import rss from "@astrojs/rss";
import type { APIContext } from "astro";
import { published } from "../content/posts";



export function GET(context: APIContext) {
  return rss({
    title: "Pikos Blog",
    description: "Articles about Pikos: the app, the architecture, the philosophy.",
    site: context.site!.toString(),
    items: published().map((post) => ({
      title: post.title,
      description: post.description,
      pubDate: new Date(post.date),
      link: `/blog/${post.slug}`,
    })),
  });
}
