import { describe, expect, it } from "vitest";

import { formatElapsed, formatSessionLength } from "./focusDuration";

describe("formatElapsed", () => {
  it.each([
    [0, "0:00"],
    [5, "0:05"],
    [59, "0:59"],
    [60, "1:00"],
    [95, "1:35"],
    [599, "9:59"],
    [3599, "59:59"],
    [3600, "1:00:00"],
    [3661, "1:01:01"],
    [36061, "10:01:01"],
  ])("%i seconds → %s", (seconds, expected) => {
    expect(formatElapsed(seconds)).toBe(expected);
  });

  it("clamps a negative input rather than rendering a minus sign", () => {
    expect(formatElapsed(-5)).toBe("0:00");
  });
});

describe("formatSessionLength", () => {
  it.each([
    [30, "1 minute"],
    [60, "1 minute"],
    [89, "1 minute"],
    [90, "2 minutes"],
    [25 * 60, "25 minutes"],
    [59 * 60, "59 minutes"],
    [60 * 60, "1 hour"],
    [61 * 60, "1 hour 1 min"],
    [95 * 60, "1 hour 35 min"],
    [120 * 60, "2 hours"],
    [150 * 60, "2 hours 30 min"],
  ])("%i seconds → %s", (seconds, expected) => {
    expect(formatSessionLength(seconds)).toBe(expected);
  });

  it("rounds to the nearest minute, so 59.5 minutes is an hour", () => {
    expect(formatSessionLength(59 * 60 + 30)).toBe("1 hour");
  });
});
