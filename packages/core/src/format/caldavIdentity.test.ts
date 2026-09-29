import { describe, expect, it } from "vitest";

import { caldavAccountIdentity, caldavBaseUrl } from "./caldavIdentity";

describe("caldavBaseUrl", () => {
  it("reads one server spelled four ways as one URL", () => {
    const spellings = [
      "Caldav.fastmail.com",
      "https://Caldav.fastmail.com",
      "https://caldav.fastmail.com",
      "  https://caldav.fastmail.com/  ",
    ].map(caldavBaseUrl);

    expect(new Set(spellings)).toEqual(new Set(["https://caldav.fastmail.com/"]));
  });

  it("keeps the path's case, which a CalDAV server does care about", () => {
    expect(caldavBaseUrl("https://Example.com/DAV/Home")).toBe("https://example.com/DAV/Home");
  });

  it("hands back something it cannot parse, leaving discovery to judge it", () => {
    expect(caldavBaseUrl("  not a url  ")).toBe("not a url");
  });
});

describe("caldavAccountIdentity", () => {
  it("pairs the trimmed username with the URL it was given", () => {
    expect(caldavAccountIdentity("  me@example.com  ", "https://caldav.fastmail.com/")).toBe(
      "me@example.com · https://caldav.fastmail.com/"
    );
  });
});
