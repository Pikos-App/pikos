import { describe, expect, it } from "vitest";

import { type Post, published } from "./posts";
import { isOut, readPublishedVersion } from "./published";

function redirectTo(location: string | null, status = 302) {
  return () =>
    Promise.resolve(new Response(null, { headers: location ? { location } : {}, status }));
}

describe("readPublishedVersion", () => {
  it("reads the version from the tag the latest release redirects to", async () => {
    const get = redirectTo("https://github.com/Pikos-App/pikos/releases/tag/v0.4.1");

    await expect(readPublishedVersion({}, get)).resolves.toBe("0.4.1");
  });

  it("takes a pinned version without asking GitHub", async () => {
    const get = () => Promise.reject(new Error("no network in this build"));

    await expect(readPublishedVersion({ PIKOS_PUBLISHED_VERSION: "0.4.2" }, get)).resolves.toBe(
      "0.4.2"
    );
  });

  it("fails the build when GitHub doesn't name a tag", async () => {
    await expect(readPublishedVersion({}, redirectTo(null, 429))).rejects.toThrow(
      /PIKOS_PUBLISHED_VERSION/
    );
  });
});

describe("a release post", () => {
  const post = (slug: string, version?: string): Post => ({
    date: "2026-01-01",
    description: "",
    slug,
    tag: "Releases",
    title: slug,
    ...(version ? { version } : {}),
  });
  const all = [post("next", "0.4.2"), post("current", "0.4.1"), post("essay")];

  it("stays out of the listing until its release is published", () => {
    expect(published("0.4.1", all).map((p) => p.slug)).toEqual(["current", "essay"]);
  });

  it("joins the listing once it is", () => {
    expect(published("0.4.2", all).map((p) => p.slug)).toEqual(["next", "current", "essay"]);
  });
});

describe("isOut", () => {
  it("holds back the version after the published one", () => {
    expect(isOut("0.4.2", "0.4.1")).toBe(false);
  });

  it("shows the published version and every earlier one", () => {
    expect(isOut("0.4.1", "0.4.1")).toBe(true);
    expect(isOut("0.3.1", "0.4.1")).toBe(true);
  });

  it("compares each part as a number, not as text", () => {
    expect(isOut("0.10.0", "0.9.3")).toBe(false);
    expect(isOut("0.9.3", "0.10.0")).toBe(true);
  });
});
