import { parseISO } from "date-fns";
import { describe, expect, it } from "vitest";

import { isPerson } from "./person";

const NOW = parseISO("2026-10-04T12:00:00Z");

function agent(userAgent: string) {
  return isPerson(new Request("https://pikos.app/", { headers: { "user-agent": userAgent } }), NOW);
}

const chrome = (major: number) =>
  `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
const iphone = (major: number) =>
  `Mozilla/5.0 (iPhone; CPU iPhone OS ${major}_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/${major}.0 Mobile/15E148 Safari/604.1`;

describe("isPerson", () => {
  it("counts current Chrome, Safari and Firefox", () => {
    expect(agent(chrome(154))).toBe(true);
    expect(agent(iphone(18))).toBe(true);
    expect(agent("Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0")).toBe(true);
  });

  // In October 2026 Chrome is at 154 by the release reckoning, so 142 is the oldest still a person.
  it("draws the Chrome line a year behind the current release", () => {
    expect(agent(chrome(142))).toBe(true);
    expect(agent(chrome(141))).toBe(false);
  });

  it("does not count the pinned Chrome builds scrapers send", () => {
    expect(agent(chrome(124))).toBe(false);
    expect(agent(chrome(131))).toBe(false);
  });

  it("does not count Safari too old for any current device", () => {
    expect(agent(iphone(13))).toBe(false);
  });

  it("does not count scripts, crawlers or scanners dressed as browsers", () => {
    expect(agent("curl/8.7.1")).toBe(false);
    expect(agent("")).toBe(false);
    expect(agent("Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)")).toBe(false);
    expect(agent(chrome(154).replace("Chrome/", "HeadlessChrome/"))).toBe(false);
    expect(agent(chrome(154).replace("(KHTML, like Gecko)", "(KHTML, like Gecko; compatible; BuiltWith/1.4)"))).toBe(false);
  });
});
