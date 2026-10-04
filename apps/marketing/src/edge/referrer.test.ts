import { describe, expect, it } from "vitest";

import { referrerToCount } from "./referrer";

const CHROME =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36";

function view(
  referer: string | null,
  {
    agent = CHROME,
    method = "GET",
    status = 200,
    type = "text/html; charset=utf-8",
  }: { agent?: string; method?: string; status?: number; type?: string } = {},
) {
  const headers = new Headers({ "user-agent": agent });
  if (referer) headers.set("referer", referer);
  return referrerToCount(
    new Request("https://pikos.app/download", { headers, method }),
    new Response(null, { headers: { "content-type": type }, status }),
  );
}

describe("referrerToCount", () => {
  it("names the site a person arrived from", () => {
    expect(view("https://news.ycombinator.com/item?id=1")).toBe("news.ycombinator.com");
  });

  it("folds www into the bare host", () => {
    expect(view("https://www.google.com/")).toBe("google.com");
  });

  it("does not count moving between pages of the site", () => {
    expect(view("https://pikos.app/")).toBeNull();
    expect(view("https://www.pikos.app/")).toBeNull();
  });

  it("does not count an arrival with no referrer or an unreadable one", () => {
    expect(view(null)).toBeNull();
    expect(view("not a url")).toBeNull();
  });

  it("counts pages only, not assets, errors or form posts", () => {
    expect(view("https://example.com/", { type: "image/png" })).toBeNull();
    expect(view("https://example.com/", { status: 404 })).toBeNull();
    expect(view("https://example.com/", { method: "POST" })).toBeNull();
  });

  it("does not count bots or scripts", () => {
    expect(view("https://example.com/", { agent: "curl/8.7.1" })).toBeNull();
    expect(view("https://example.com/", { agent: "Mozilla/5.0 (compatible; Googlebot/2.1)" })).toBeNull();
  });
});
