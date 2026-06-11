import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CalendarSettingsProvider, useCalendarSettings } from "./CalendarSettingsContext";

function wrapper({ children }: { children: ReactNode }) {
  return <CalendarSettingsProvider>{children}</CalendarSettingsProvider>;
}

function setup() {
  return renderHook(() => useCalendarSettings(), { wrapper });
}

beforeEach(() => {
  localStorage.clear();
});
afterEach(() => {
  localStorage.clear();
});

describe("dayCount", () => {
  it("defaults to 7", () => {
    const { result } = setup();
    expect(result.current.dayCount).toBe(7);
  });

  it("can be set to each option", () => {
    const { result } = setup();
    for (const count of [1, 3, 5, "mf", 7] as const) {
      act(() => result.current.setDayCount(count));
      expect(result.current.dayCount).toBe(count);
    }
  });

  it("persists to localStorage", () => {
    const { result } = setup();
    act(() => result.current.setDayCount(3));
    expect(JSON.parse(localStorage.getItem("pikos:calendarDayCount")!)).toBe(3);
  });

  it("persists 'mf' as a string", () => {
    const { result } = setup();
    act(() => result.current.setDayCount("mf"));
    expect(JSON.parse(localStorage.getItem("pikos:calendarDayCount")!)).toBe("mf");
  });
});

describe("density", () => {
  it("defaults to 'normal'", () => {
    const { result } = setup();
    expect(result.current.density).toBe("normal");
    expect(result.current.metrics.hourHeight).toBe(64);
  });

  it("metrics scale with density", () => {
    const { result } = setup();
    act(() => result.current.setDensity("compact"));
    expect(result.current.metrics.hourHeight).toBe(40);
    act(() => result.current.setDensity("spacious"));
    expect(result.current.metrics.hourHeight).toBe(88);
  });

  it("gridHeight = 24 * hourHeight for all densities", () => {
    const { result } = setup();
    for (const d of ["compact", "normal", "spacious"] as const) {
      act(() => result.current.setDensity(d));
      expect(result.current.metrics.gridHeight).toBe(result.current.metrics.hourHeight * 24);
    }
  });

  it("persists to localStorage", () => {
    const { result } = setup();
    act(() => result.current.setDensity("spacious"));
    expect(JSON.parse(localStorage.getItem("pikos:calendarDensity")!)).toBe("spacious");
  });
});

describe("collapse bands", () => {
  it("default: both collapsed, top=6, bottom=22", () => {
    const { result } = setup();
    expect(result.current.collapse).toEqual({
      bottomCollapsed: true,
      bottomHour: 22,
      topCollapsed: true,
      topHour: 6,
    });
  });

  it("setTopCollapsed / setBottomCollapsed toggle and persist", () => {
    const { result } = setup();
    act(() => result.current.setTopCollapsed(false));
    expect(result.current.collapse.topCollapsed).toBe(false);
    expect(JSON.parse(localStorage.getItem("pikos:calendarTopCollapsed")!)).toBe(false);

    act(() => result.current.setBottomCollapsed(false));
    expect(result.current.collapse.bottomCollapsed).toBe(false);
    expect(JSON.parse(localStorage.getItem("pikos:calendarBottomCollapsed")!)).toBe(false);
  });

  it("setTopHour clamps to legal range", () => {
    const { result } = setup();
    act(() => result.current.setTopHour(30)); // > MAX_TOP_HOUR
    expect(result.current.collapse.topHour).toBe(12);
    act(() => result.current.setTopHour(-5));
    expect(result.current.collapse.topHour).toBe(0);
    act(() => result.current.setTopHour(8));
    expect(result.current.collapse.topHour).toBe(8);
  });

  it("setBottomHour clamps relative to topHour", () => {
    const { result } = setup();
    act(() => result.current.setTopHour(10));
    act(() => result.current.setBottomHour(8)); // would be < topHour
    expect(result.current.collapse.bottomHour).toBe(12); // clamped to MIN_BOTTOM_HOUR
  });

  it("geometry reflects collapsed state", () => {
    const { result } = setup();
    // default: both collapsed at 6 and 22 → top=40, mid=16h, bottom=40
    expect(result.current.geometry.topBandHeight).toBe(40);
    expect(result.current.geometry.bottomBandHeight).toBe(40);
    expect(result.current.geometry.middleHeight).toBe(16 * 64);

    act(() => result.current.setTopCollapsed(false));
    // top expanded → topBandHeight = 6 * hourHeight
    expect(result.current.geometry.topBandHeight).toBe(6 * 64);
  });

  it("hour boundary state survives provider remount (localStorage round-trip)", () => {
    const first = setup();
    act(() => first.result.current.setTopHour(8));
    act(() => first.result.current.setBottomHour(20));
    act(() => first.result.current.setTopCollapsed(false));
    first.unmount();

    const second = setup();
    expect(second.result.current.collapse).toEqual({
      bottomCollapsed: true,
      bottomHour: 20,
      topCollapsed: false,
      topHour: 8,
    });
  });
});
