import { describe, expect, it } from "vitest";

import {
  BREAKPOINTS,
  getCalendarDayCount,
  getLayoutMode,
  shouldHideSidebar,
  shouldOverlayPageList,
} from "./breakpoints";

describe("getLayoutMode", () => {
  it("returns xl at and above 1280", () => {
    expect(getLayoutMode(1280)).toBe("xl");
    expect(getLayoutMode(1920)).toBe("xl");
  });

  it("returns lg between 1024 and 1279", () => {
    expect(getLayoutMode(1024)).toBe("lg");
    expect(getLayoutMode(1279)).toBe("lg");
  });

  it("returns md between 760 and 1023", () => {
    expect(getLayoutMode(760)).toBe("md");
    expect(getLayoutMode(1023)).toBe("md");
  });

  it("returns sm below 760", () => {
    expect(getLayoutMode(759)).toBe("sm");
    expect(getLayoutMode(400)).toBe("sm");
    expect(getLayoutMode(0)).toBe("sm");
  });

  it("thresholds line up with BREAKPOINTS constants", () => {
    expect(getLayoutMode(BREAKPOINTS.xl)).toBe("xl");
    expect(getLayoutMode(BREAKPOINTS.lg)).toBe("lg");
    expect(getLayoutMode(BREAKPOINTS.md)).toBe("md");
  });
});

describe("getCalendarDayCount", () => {
  it("shows 7 days only at xl", () => {
    expect(getCalendarDayCount("xl")).toBe(7);
  });

  it("shows 5 days at lg and md", () => {
    expect(getCalendarDayCount("lg")).toBe(5);
    expect(getCalendarDayCount("md")).toBe(5);
  });

  it("shows 3 days at sm", () => {
    expect(getCalendarDayCount("sm")).toBe(3);
  });
});

describe("shouldHideSidebar", () => {
  it("keeps the sidebar at xl and lg", () => {
    expect(shouldHideSidebar("xl")).toBe(false);
    expect(shouldHideSidebar("lg")).toBe(false);
  });

  it("hides the sidebar at md and sm", () => {
    expect(shouldHideSidebar("md")).toBe(true);
    expect(shouldHideSidebar("sm")).toBe(true);
  });
});

describe("shouldOverlayPageList", () => {
  it("only overlays at sm", () => {
    expect(shouldOverlayPageList("xl")).toBe(false);
    expect(shouldOverlayPageList("lg")).toBe(false);
    expect(shouldOverlayPageList("md")).toBe(false);
    expect(shouldOverlayPageList("sm")).toBe(true);
  });
});
