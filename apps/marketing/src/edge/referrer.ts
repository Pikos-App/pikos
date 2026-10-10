import { isPerson } from "./person";

/** The site that sent a page view, or null when the request isn't a person arriving on a page. */
export function referrerToCount(request: Request, response: Response, now: Date): string | null {
  if (request.method !== "GET" || response.status !== 200) return null;
  if (!response.headers.get("content-type")?.startsWith("text/html")) return null;
  if (!isPerson(request, now)) return null;
  const referrer = hostOf(request.headers.get("referer"));
  if (!referrer || referrer === hostOf(request.url)) return null;
  return referrer;
}

function hostOf(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}
