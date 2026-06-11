import { describe, expect, it } from "vitest";

import { parseDeepLink } from "./parseDeepLink";

const UUID = "550e8400-e29b-41d4-a716-446655440000";

describe("parseDeepLink", () => {
  it("parses page navigation with a valid UUID", () => {
    expect(parseDeepLink(`pikos://page/${UUID}`)).toEqual({ pageId: UUID, type: "page" });
  });

  it("rejects page URLs without a UUID", () => {
    expect(parseDeepLink("pikos://page")).toBeNull();
    expect(parseDeepLink("pikos://page/")).toBeNull();
    expect(parseDeepLink("pikos://page/not-a-uuid")).toBeNull();
  });

  it("parses smart views", () => {
    expect(parseDeepLink("pikos://today")).toEqual({ type: "view", viewId: "today" });
    expect(parseDeepLink("pikos://inbox")).toEqual({ type: "view", viewId: "inbox" });
  });

  it("rejects smart views with trailing segments", () => {
    expect(parseDeepLink("pikos://today/extra")).toBeNull();
  });

  it("parses calendar (notification click)", () => {
    expect(parseDeepLink("pikos://calendar")).toEqual({ type: "calendar" });
  });

  it("rejects calendar with trailing segments", () => {
    expect(parseDeepLink("pikos://calendar/extra")).toBeNull();
  });

  it("parses quick-add with text prefill", () => {
    expect(parseDeepLink("pikos://quick-add?text=Buy%20milk")).toEqual({
      prefill: "Buy milk",
      type: "quick-add",
    });
  });

  it("parses quick-add with empty text", () => {
    expect(parseDeepLink("pikos://quick-add")).toEqual({ prefill: "", type: "quick-add" });
  });

  it("parses search with q prefill", () => {
    expect(parseDeepLink("pikos://search?q=meeting%20notes")).toEqual({
      prefill: "meeting notes",
      type: "search",
    });
  });

  it("parses search with empty q", () => {
    expect(parseDeepLink("pikos://search")).toEqual({ prefill: "", type: "search" });
  });

  it("rejects unknown verbs", () => {
    expect(parseDeepLink("pikos://nonsense")).toBeNull();
    expect(parseDeepLink("pikos://page/abc/def")).toBeNull();
  });

  it("rejects non-pikos schemes", () => {
    expect(parseDeepLink(`https://example.com/page/${UUID}`)).toBeNull();
    expect(parseDeepLink(`file://page/${UUID}`)).toBeNull();
  });

  it("rejects malformed URLs", () => {
    expect(parseDeepLink("not a url")).toBeNull();
    expect(parseDeepLink("")).toBeNull();
  });

  it("normalises extra slashes", () => {
    expect(parseDeepLink(`pikos:///page/${UUID}`)).toEqual({ pageId: UUID, type: "page" });
  });
});
