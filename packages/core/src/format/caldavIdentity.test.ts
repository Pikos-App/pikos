import { describe, expect, it } from "vitest";

import { caldavAccountIdentity, caldavBaseUrl, caldavSendsPasswordInClear } from "./caldavIdentity";

describe("caldavBaseUrl", () => {
  // qa: SYNC-03:3
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

describe("caldavSendsPasswordInClear", () => {
  it("is true for plain http to another host, on a LAN or not", () => {
    expect(caldavSendsPasswordInClear("http://nas.local/dav")).toBe(true);
    expect(caldavSendsPasswordInClear("  HTTP://192.168.1.20:5232  ")).toBe(true);
    expect(caldavSendsPasswordInClear("http://caldav.example.com")).toBe(true);
  });

  it("is false for https, a bare host, this machine, or something unparseable", () => {
    expect(caldavSendsPasswordInClear("https://caldav.example.com")).toBe(false);
    expect(caldavSendsPasswordInClear("caldav.example.com")).toBe(false);
    expect(caldavSendsPasswordInClear("http://localhost:5232")).toBe(false);
    expect(caldavSendsPasswordInClear("http://127.0.0.1:5232")).toBe(false);
    expect(caldavSendsPasswordInClear("http://[::1]:5232")).toBe(false);
    expect(caldavSendsPasswordInClear("http://")).toBe(false);
  });
});

describe("caldavAccountIdentity", () => {
  it("pairs the trimmed username with the URL it was given", () => {
    expect(caldavAccountIdentity("  me@example.com  ", "https://caldav.fastmail.com/")).toBe(
      "me@example.com · https://caldav.fastmail.com/"
    );
  });
});
