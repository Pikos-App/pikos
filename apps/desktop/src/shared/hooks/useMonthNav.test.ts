import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { useMonthNav } from "./useMonthNav";

describe("useMonthNav", () => {
  it("initializes from the given date", () => {
    const { result } = renderHook(() => useMonthNav(new Date(2026, 5, 15)));
    expect(result.current.year).toBe(2026);
    expect(result.current.month).toBe(5);
  });

  it("next() steps forward and wraps December → January next year", () => {
    const { result } = renderHook(() => useMonthNav(new Date(2026, 11, 1)));
    act(() => result.current.next());
    expect(result.current.year).toBe(2027);
    expect(result.current.month).toBe(0);
  });

  it("prev() steps backward and wraps January → December prev year", () => {
    const { result } = renderHook(() => useMonthNav(new Date(2026, 0, 1)));
    act(() => result.current.prev());
    expect(result.current.year).toBe(2025);
    expect(result.current.month).toBe(11);
  });

  it("reset() jumps to the given date", () => {
    const { result } = renderHook(() => useMonthNav(new Date(2026, 0, 1)));
    act(() => result.current.reset(new Date(2027, 7, 10)));
    expect(result.current.year).toBe(2027);
    expect(result.current.month).toBe(7);
  });
});
