import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useMinuteTick } from "./useMinuteTick";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("useMinuteTick", () => {
  it("starts at 0", () => {
    vi.setSystemTime(new Date("2026-03-31T12:00:00"));
    const { result } = renderHook(() => useMinuteTick());
    expect(result.current).toBe(0);
  });

  it("ticks at the next whole minute boundary", async () => {
    // Mount at 30s past the minute → first tick should fire in 30s
    vi.setSystemTime(new Date("2026-03-31T12:00:30.000"));
    const { result } = renderHook(() => useMinuteTick());

    // Advance 29s — no tick yet
    await act(() => vi.advanceTimersByTime(29_000));
    expect(result.current).toBe(0);

    // Advance to 30s mark — first tick
    await act(() => vi.advanceTimersByTime(1_000));
    expect(result.current).toBe(1);
  });

  it("ticks every 60s after the initial alignment", async () => {
    vi.setSystemTime(new Date("2026-03-31T12:00:00.000"));
    const { result } = renderHook(() => useMinuteTick());

    // First tick at :01:00
    await act(() => vi.advanceTimersByTime(60_000));
    expect(result.current).toBe(1);

    // Second tick at :02:00
    await act(() => vi.advanceTimersByTime(60_000));
    expect(result.current).toBe(2);

    // Third tick at :03:00
    await act(() => vi.advanceTimersByTime(60_000));
    expect(result.current).toBe(3);
  });

  it("cleans up timers on unmount", () => {
    vi.setSystemTime(new Date("2026-03-31T12:00:30.000"));
    const { unmount } = renderHook(() => useMinuteTick());

    unmount();

    // Advance well past the next minute — no errors, no unhandled timers
    expect(() => vi.advanceTimersByTime(120_000)).not.toThrow();
  });
});
