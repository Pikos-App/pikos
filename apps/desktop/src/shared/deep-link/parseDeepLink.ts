// Parse pikos:// URLs into a typed action.
//
// Supported shapes:
//   pikos://page/<uuid>            → navigate to a page
//   pikos://today                  → smart view "Today"
//   pikos://inbox                  → smart view "Inbox"
//   pikos://calendar               → calendar at the current time (notification click)
//   pikos://quick-add?text=...     → open quick-add prefilled
//   pikos://search?q=...           → open search prefilled
//
// Unknown or malformed URLs return null. The router treats null as a no-op.

export type DeepLinkAction =
  | { type: "page"; pageId: string }
  | { type: "view"; viewId: "today" | "inbox" }
  | { type: "calendar" }
  | { type: "quick-add"; prefill: string }
  | { type: "search"; prefill: string };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseDeepLink(raw: string): DeepLinkAction | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "pikos:") return null;

  // URL.host is empty for `pikos://today` on some implementations and `today`
  // on others (host parsing differs across spec variants). Normalise by
  // joining host + pathname and trimming separators.
  const path = `${url.host}${url.pathname}`.replace(/^\/+|\/+$/g, "");
  const segments = path.split("/").filter(Boolean);
  const [head, ...rest] = segments;
  if (!head) return null;

  switch (head) {
    case "page": {
      const id = rest[0];
      if (!id || !UUID_RE.test(id)) return null;
      return { pageId: id, type: "page" };
    }
    case "today":
    case "inbox":
      if (rest.length > 0) return null;
      return { type: "view", viewId: head };
    case "calendar":
      if (rest.length > 0) return null;
      return { type: "calendar" };
    case "quick-add": {
      if (rest.length > 0) return null;
      const text = url.searchParams.get("text") ?? "";
      return { prefill: text, type: "quick-add" };
    }
    case "search": {
      if (rest.length > 0) return null;
      const q = url.searchParams.get("q") ?? "";
      return { prefill: q, type: "search" };
    }
    default:
      return null;
  }
}
