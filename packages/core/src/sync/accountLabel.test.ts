import { describe, expect, it } from "vitest";

import { accountAddress, accountProviderLabel, accountServerUrl } from "./accountLabel";

const caldav = {
  displayName: "hello@alex-ak.com · https://caldav.fastmail.com",
  provider: "caldav",
};
const google = { displayName: "kingaa6@gmail.com", provider: "google" };

describe("accountAddress", () => {
  it("drops the server a CalDAV account was stored against", () => {
    expect(accountAddress(caldav)).toBe("hello@alex-ak.com");
  });

  it("leaves an account with no server half alone", () => {
    expect(accountAddress(google)).toBe("kingaa6@gmail.com");
  });

  it("keeps an address containing the separator intact up to the server", () => {
    // The separator is only meaningful once; a stored value is never re-split.
    expect(accountAddress({ displayName: "a · b · c" })).toBe("a");
  });
});

describe("accountServerUrl", () => {
  it("returns the server half, which the reconnect dialog still needs", () => {
    expect(accountServerUrl(caldav)).toBe("https://caldav.fastmail.com");
  });

  it("is null when there is no server half", () => {
    expect(accountServerUrl(google)).toBeNull();
  });
});

describe("accountProviderLabel", () => {
  it("names the service behind a known CalDAV host", () => {
    expect(accountProviderLabel(caldav)).toBe("Fastmail");
  });

  it("says CalDAV rather than guessing a brand from an unknown host", () => {
    expect(
      accountProviderLabel({
        displayName: "me@x.com · https://dav.example.org",
        provider: "caldav",
      })
    ).toBe("CalDAV");
  });

  it("names Google without needing a host", () => {
    expect(accountProviderLabel(google)).toBe("Google");
  });
});
