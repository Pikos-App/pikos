import { describe, expect, it, vi } from "vitest";

import { TauriPlatformAdapter } from "./TauriPlatformAdapter";

const ASSETS = "/Volumes/Next Mac/Pikos/assets";
const NAME = "3f2b8c1e-5d4a-4b6f-9e2d-7a1c0b9f8e6d.png";

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (path: string) => `asset://localhost/${path}`,
  invoke: (command: string) =>
    command === "init_assets_dir" ? Promise.resolve(ASSETS) : Promise.reject(new Error(command)),
}));

describe("TauriPlatformAdapter.assetUrl", () => {
  // qa: PRIV-04:4
  it("shows a stored image, and one saved on another Mac, from this machine's assets", async () => {
    const platform = new TauriPlatformAdapter();
    await platform.ensureAssetsDir();

    expect(platform.assetUrl(`assets/${NAME}`)).toBe(`asset://localhost/${ASSETS}/${NAME}`);
    expect(platform.assetUrl(`/Volumes/Old Mac/Pikos/assets/${NAME}`)).toBe(
      `asset://localhost/${ASSETS}/${NAME}`
    );
  });
});
