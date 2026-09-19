import { describe, expect, it } from "vitest";

import { formatTime12h, formatTime12hParts } from "./formatTime";

describe("formatTime12h", () => {
  it("formats AM hour without minutes", () => {
    expect(formatTime12h(new Date(2026, 0, 1, 9, 0))).toBe("9 AM");
  });

  it("formats PM hour with minutes", () => {
    expect(formatTime12h(new Date(2026, 0, 1, 14, 30))).toBe("2:30 PM");
  });

  it("renders midnight as 12 AM", () => {
    expect(formatTime12h(new Date(2026, 0, 1, 0, 0))).toBe("12 AM");
  });

  it("renders noon as 12 PM", () => {
    expect(formatTime12h(new Date(2026, 0, 1, 12, 0))).toBe("12 PM");
  });

  it("omits the period when period: false", () => {
    expect(formatTime12h(new Date(2026, 0, 1, 9, 30), { period: false })).toBe("9:30");
  });
});

describe("formatTime12hParts", () => {
  it("pads single-digit minutes", () => {
    expect(formatTime12hParts(9, 5)).toBe("9:05 AM");
  });

  it("uses 12 for 0 and 12", () => {
    expect(formatTime12hParts(0, 0)).toBe("12 AM");
    expect(formatTime12hParts(12, 0)).toBe("12 PM");
  });
});
