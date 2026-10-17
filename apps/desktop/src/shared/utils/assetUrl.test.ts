import { convertFileSrc } from "@tauri-apps/api/core";
import { describe, expect, it, vi } from "vitest";

import { assetUrl } from "./assetUrl";

// The real `convertFileSrc` reads Tauri's runtime config, which does not exist
// under vitest. The stand-in returns a recognisable scheme so the assertions
// below can be about *delegation* rather than about Tauri's URL format, which
// is Tauri's business and changes between versions.
vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: vi.fn((path: string) => `asset://localhost/${encodeURIComponent(path)}`),
}));

describe("assetUrl", () => {
  it("hands the path to Tauri rather than returning it unchanged", () => {
    const url = assetUrl("/pikos/workspace/assets/diagram.png");

    // The whole point: a bare filesystem path in an <img src> loads nothing.
    expect(url).not.toBe("/pikos/workspace/assets/diagram.png");
    expect(url.startsWith("asset://")).toBe(true);
    expect(convertFileSrc).toHaveBeenCalledWith("/pikos/workspace/assets/diagram.png");
  });

  it("passes the path through verbatim, including characters a URL would escape", () => {
    // Escaping is Tauri's to do — doing it here as well would double-encode
    // and break every path with a space in it.
    assetUrl("/pikos/My Workspace/a b&c.png");

    expect(convertFileSrc).toHaveBeenLastCalledWith("/pikos/My Workspace/a b&c.png");
  });
});
