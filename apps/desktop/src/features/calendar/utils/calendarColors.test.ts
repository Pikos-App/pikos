import { describe, expect, it } from "vitest";

import { chipFolderStyle, hexToRgba } from "./calendarColors";

describe("chipFolderStyle", () => {
  it("returns --event-color CSS property when a folder color is provided", () => {
    const style = chipFolderStyle("#ff0000") as Record<string, string>;
    expect(style["--event-color"]).toBe("#ff0000");
  });

  it("falls back to the default event color when none is provided", () => {
    const style = chipFolderStyle() as Record<string, string>;
    expect(style["--event-color"]).toBeTruthy();
  });
});

describe("hexToRgba", () => {
  it("valid hex → correct rgba string", () => {
    expect(hexToRgba("#ff0000", 0.5)).toBe("rgba(255,0,0,0.5)");
  });

  it("valid hex without # → correct rgba string", () => {
    expect(hexToRgba("00ff00", 0.25)).toBe("rgba(0,255,0,0.25)");
  });

  it("invalid hex → fallback indigo", () => {
    expect(hexToRgba("zzz", 0.5)).toBe("rgba(99,102,241,0.5)");
  });
});
