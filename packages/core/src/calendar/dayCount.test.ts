import { describe, expect, it } from "vitest";

import { clampDayCount, dayCountColumns, dayCountNavStep } from "./dayCount";

describe("dayCountColumns", () => {
  it("numeric values pass through", () => {
    expect(dayCountColumns(1)).toBe(1);
    expect(dayCountColumns(3)).toBe(3);
    expect(dayCountColumns(5)).toBe(5);
    expect(dayCountColumns(7)).toBe(7);
  });

  it("'mf' renders 5 columns", () => {
    expect(dayCountColumns("mf")).toBe(5);
  });
});

describe("dayCountNavStep", () => {
  it("numeric values step by their count", () => {
    expect(dayCountNavStep(1)).toBe(1);
    expect(dayCountNavStep(5)).toBe(5);
    expect(dayCountNavStep(7)).toBe(7);
  });

  it("'mf' steps by 7 so next page lands on the following Monday", () => {
    expect(dayCountNavStep("mf")).toBe(7);
  });
});

describe("clampDayCount", () => {
  it("returns preferred when it fits", () => {
    expect(clampDayCount(7, 7)).toBe(7);
    expect(clampDayCount("mf", 7)).toBe("mf");
    expect(clampDayCount(3, 5)).toBe(3);
  });

  it("demotes 7 to the largest numeric value the breakpoint allows", () => {
    expect(clampDayCount(7, 5)).toBe(5);
    expect(clampDayCount(7, 3)).toBe(3);
    expect(clampDayCount(7, 1)).toBe(1);
  });

  it("demotes 'mf' to 3 when only 3 columns fit (no work-week subset exists)", () => {
    expect(clampDayCount("mf", 3)).toBe(3);
    expect(clampDayCount("mf", 1)).toBe(1);
  });
});
