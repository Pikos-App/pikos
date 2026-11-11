import { act, render, renderHook, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useNow } from "./useNow";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

function Clock() {
  const now = useNow();
  return <span>{`${now.getHours()}:${now.getMinutes()}`}</span>;
}

describe("useNow", () => {
  it("moves at the next whole minute and every minute after", async () => {
    vi.setSystemTime(new Date("2026-03-31T12:00:30.000"));
    const { result } = renderHook(() => useNow());
    expect(result.current.getMinutes()).toBe(0);

    await act(() => vi.advanceTimersByTime(29_000));
    expect(result.current.getMinutes()).toBe(0);
    await act(() => vi.advanceTimersByTime(1_000));
    expect(result.current.getMinutes()).toBe(1);
    await act(() => vi.advanceTimersByTime(60_000));
    expect(result.current.getMinutes()).toBe(2);
  });

  it("re-renders what reads it through the compiler's cache", async () => {
    vi.setSystemTime(new Date("2026-03-31T12:00:00.000"));
    render(<Clock />);
    expect(screen.getByText("12:0")).toBeInTheDocument();

    await act(() => vi.advanceTimersByTime(30 * 60_000));
    expect(screen.getByText("12:30")).toBeInTheDocument();
  });

  it("catches up as soon as the window comes back, though its timer was held back", async () => {
    vi.setSystemTime(new Date("2026-03-31T12:00:30.000"));
    const { result } = renderHook(() => useNow());

    vi.setSystemTime(new Date("2026-03-31T12:20:10.000"));
    await act(() => window.dispatchEvent(new Event("focus")));
    expect(result.current.getMinutes()).toBe(20);

    await act(() => vi.advanceTimersByTime(50_000));
    expect(result.current.getMinutes()).toBe(21);
  });

  it("stops its timers on unmount", () => {
    vi.setSystemTime(new Date("2026-03-31T12:00:30.000"));
    const { unmount } = renderHook(() => useNow());
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
