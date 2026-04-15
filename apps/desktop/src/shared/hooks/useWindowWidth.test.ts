import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { useWindowWidth } from "./useWindowWidth";

function setWidth(w: number) {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: w, writable: true });
  window.dispatchEvent(new Event("resize"));
}

describe("useWindowWidth", () => {
  it("returns the current window width", () => {
    setWidth(1200);
    const { result } = renderHook(() => useWindowWidth());
    expect(result.current).toBe(1200);
  });

  it("updates on window resize", () => {
    setWidth(1200);
    const { result } = renderHook(() => useWindowWidth());
    expect(result.current).toBe(1200);

    act(() => setWidth(800));
    expect(result.current).toBe(800);

    act(() => setWidth(1500));
    expect(result.current).toBe(1500);
  });
});
