import type { VirtualRow } from "@pikos/core";
import { describe, expect, it } from "vitest";

import { listShift } from "./useScrollAnchor";

const rows = (...keys: string[]): VirtualRow[] =>
  keys.map((key) => ({ id: key, key, slot: { index: 0, section: "s" }, type: "placeholder" }));
const seen = (...keys: string[]) => new Map(keys.map((key, i) => [key, i + 2]));

describe("listShift", () => {
  it("follows the list when rows are added above what was on screen", () => {
    expect(listShift(seen("c", "d", "e"), rows("x", "y", "a", "b", "c", "d", "e"))).toBe(2);
  });

  it("never follows a row that moved on its own", () => {
    expect(listShift(seen("c", "d", "e"), rows("a", "b", "d", "e", "f", "g", "c"))).toBe(-1);
  });

  it("has nothing to follow when every row on screen is gone", () => {
    expect(listShift(seen("c", "d"), rows("a", "b"))).toBeNull();
  });
});
