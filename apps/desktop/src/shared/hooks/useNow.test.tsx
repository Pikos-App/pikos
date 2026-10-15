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

  it("stops its timers on unmount", () => {
    vi.setSystemTime(new Date("2026-03-31T12:00:30.000"));
    const { unmount } = renderHook(() => useNow());
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
