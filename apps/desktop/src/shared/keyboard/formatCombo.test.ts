import { describe, expect, it } from "vitest";

import { IS_MACOS } from "@/shared/constants/platform";

import { formatCombo } from "./formatCombo";

const MOD = IS_MACOS ? "⌘" : "Ctrl";
const ALT = IS_MACOS ? "⌥" : "Alt";

describe("formatCombo", () => {
  it("splits a combo into one token per key", () => {
    expect(formatCombo("Mod+Shift+K")).toEqual([MOD, "⇧", "K"]);
  });

  it("renders the platform modifier for Mod and Alt", () => {
    expect(formatCombo("Mod+N")).toEqual([MOD, "N"]);
    expect(formatCombo("Alt+N")).toEqual([ALT, "N"]);
    expect(formatCombo("Option+N")).toEqual([ALT, "N"]);
  });

  it("maps named keys to their glyphs", () => {
    expect(formatCombo("Enter")).toEqual(["↵"]);
    expect(formatCombo("Tab")).toEqual(["⇥"]);
    expect(formatCombo("Escape")).toEqual(["Esc"]);
    expect(formatCombo("Space")).toEqual(["Space"]);
    expect(formatCombo("ArrowUp")).toEqual(["↑"]);
    expect(formatCombo("ArrowDown")).toEqual(["↓"]);
    expect(formatCombo("ArrowLeft")).toEqual(["←"]);
    expect(formatCombo("ArrowRight")).toEqual(["→"]);
  });

  it("upper-cases a bare letter and leaves punctuation alone", () => {
    expect(formatCombo("t")).toEqual(["T"]);
    expect(formatCombo("Mod+,")).toEqual([MOD, ","]);
    expect(formatCombo("Mod+\\")).toEqual([MOD, "\\"]);
  });
});
