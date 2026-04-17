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
    for (const count of [1, 3, 5, 7] as const) {
      act(() => result.current.setDayCount(count));
      expect(result.current.dayCount).toBe(count);
    }
  });

  it("persists to localStorage", () => {
    const { result } = setup();
    act(() => result.current.setDayCount(3));
    expect(JSON.parse(localStorage.getItem("pikos:calendarDayCount")!)).toBe(3);
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
