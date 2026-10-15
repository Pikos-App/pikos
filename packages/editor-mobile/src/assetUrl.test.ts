import { describe, expect, it } from "vitest";

import { resolveAssetUrl } from "./assetUrl";

const NAME = "3f2b8c1e-5d4a-4b6f-9e2d-7a1c0b9f8e6d.png";

describe("resolveAssetUrl", () => {
  it("serves a page's stored path from the assets folder", () => {
    expect(resolveAssetUrl(`assets/${NAME}`)).toBe(`pikos-asset://asset/${NAME}`);
  });

  it("finds a full path saved on another machine by its file name", () => {
    expect(resolveAssetUrl(`/Volumes/Old Mac/Pikos/assets/${NAME}`)).toBe(
      `pikos-asset://asset/${NAME}`
    );
  });

  it("serves a bare name the phone stored before as it is", () => {
    expect(resolveAssetUrl("photo 1.jpg")).toBe("pikos-asset://asset/photo%201.jpg");
  });
});
