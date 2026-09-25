import { describe, expect, it } from "vitest";

import { caldavAccountIdentity } from "./caldavIdentity";

describe("caldavAccountIdentity", () => {
  it("reads one server spelled three ways as one account", () => {
    const typed = [
      "https://Caldav.fastmail.com",
      "https://caldav.fastmail.com",
      "https://caldav.fastmail.com/",
    ].map((url) => caldavAccountIdentity("me@example.com", url));

    expect(new Set(typed).size).toBe(1);
  });

  it("keeps the path's case, which a server may care about", () => {
    expect(caldavAccountIdentity("me", "https://example.com/DAV/Home")).toContain("/DAV/Home");
  });

  it("passes through a URL it cannot parse, leaving discovery to judge it", () => {
    expect(caldavAccountIdentity("me", "not a url")).toBe("me · not a url");
  });
});
