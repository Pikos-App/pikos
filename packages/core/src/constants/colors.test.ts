import { describe, expect, it } from "vitest";

import {
  currentPaletteColor,
  defaultColorForProvider,
  PALETTE_COLORS,
  withCurrentColor,
} from "./colors";

describe("currentPaletteColor", () => {
  it("draws a folder stored with the old red as the palette's red, in either case", () => {
    const red = PALETTE_COLORS.find((c) => c.label === "Red")!.value;
    expect(currentPaletteColor("#E5534B")).toBe(red);
    expect(currentPaletteColor("#e5534b")).toBe(red);
  });

  it("leaves every current palette colour and an empty colour as they are", () => {
    for (const { value } of PALETTE_COLORS) expect(currentPaletteColor(value)).toBe(value);
    expect(currentPaletteColor(null)).toBeNull();
  });
});

describe("withCurrentColor", () => {
  it("returns a copy carrying the current colour when the stored one has moved", () => {
    const folder = { color: "#E5534B", id: "f1" };
    const drawn = withCurrentColor(folder);
    expect(drawn).toEqual({ color: "#D9577A", id: "f1" });
    expect(folder.color).toBe("#E5534B");
  });

  it("returns the same object when nothing moved, so a list of them keeps its identity", () => {
    const current = { color: "#D9577A", id: "f1" };
    const uncoloured = { color: null, id: "f2" };
    expect(withCurrentColor(current)).toBe(current);
    expect(withCurrentColor(uncoloured)).toBe(uncoloured);
  });
});

describe("PALETTE_COLORS", () => {
  it("holds unique #RRGGBB values with distinct labels", () => {
    const values = PALETTE_COLORS.map((c) => c.value);
    const labels = PALETTE_COLORS.map((c) => c.label);
    expect(new Set(values).size).toBe(values.length);
    expect(new Set(labels).size).toBe(labels.length);
    for (const value of values) expect(value).toMatch(/^#[0-9A-F]{6}$/i);
  });
});

describe("defaultColorForProvider", () => {
  it("gives each known provider a colour from the palette", () => {
    const values = PALETTE_COLORS.map((c) => c.value);
    expect(values).toContain(defaultColorForProvider("google"));
    expect(values).toContain(defaultColorForProvider("caldav"));
    expect(defaultColorForProvider("google")).not.toBe(defaultColorForProvider("caldav"));
  });

  it("falls back to Sky for an unknown provider", () => {
    expect(defaultColorForProvider("exchange")).toBe("#A6C8E8");
  });
});
