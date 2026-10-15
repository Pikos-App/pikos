import { describe, expect, it } from "vitest";

import { CALENDAR_TEXT_SIZES, calendarTextScale } from "@/shared/context/CalendarSettingsContext";

import { calendarGutterPx } from "./gutterWidth";

describe("calendarGutterPx", () => {
  it("gives every text size on the ladder a whole number of pixels", () => {
    for (const size of CALENDAR_TEXT_SIZES) {
      const width = calendarGutterPx(calendarTextScale(size));
      expect(Number.isInteger(width)).toBe(true);
    }
  });

  it("rounds the default size's 60.3px down to 60", () => {
    expect(calendarGutterPx(calendarTextScale(14))).toBe(60);
  });

  it("never narrows the gutter as the text grows", () => {
    const widths = CALENDAR_TEXT_SIZES.map((size) => calendarGutterPx(calendarTextScale(size)));
    expect(widths).toStrictEqual([...widths].sort((a, b) => a - b));
  });
});
