import { describe, expect, it } from "vitest";

import { defaultColorForProvider, PALETTE_COLORS } from "./colors";

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
