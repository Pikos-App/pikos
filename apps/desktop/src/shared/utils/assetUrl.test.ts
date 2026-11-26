import { convertFileSrc } from "@tauri-apps/api/core";
import { describe, expect, it, vi } from "vitest";

import { assetUrl } from "./assetUrl";

// The real `convertFileSrc` reads Tauri's runtime config, absent under vitest. The stand-in lets
// assertions be about delegation, not Tauri's URL format.
vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: vi.fn((path: string) => `asset://localhost/${encodeURIComponent(path)}`),
}));

describe("assetUrl", () => {
  it("hands the path to Tauri rather than returning it unchanged", () => {
    const url = assetUrl("/pikos/workspace/assets/diagram.png");

    expect(url).not.toBe("/pikos/workspace/assets/diagram.png");
    expect(url.startsWith("asset://")).toBe(true);
    expect(convertFileSrc).toHaveBeenCalledWith("/pikos/workspace/assets/diagram.png");
  });

  it("passes the path through verbatim, including characters a URL would escape", () => {
    // Escaping is Tauri's job; doing it here too would double-encode paths with a space.
    assetUrl("/pikos/My Workspace/a b&c.png");

    expect(convertFileSrc).toHaveBeenLastCalledWith("/pikos/My Workspace/a b&c.png");
  });
});
