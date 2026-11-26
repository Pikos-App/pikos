import { act, cleanup, render, renderHook, screen } from "@testing-library/react";
import { Activity } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useNow } from "./useNow";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  // The clock is one for the app, so a reader left mounted would carry it into the next test.
  cleanup();
  vi.useRealTimers();
});

function Clock() {
  const now = useNow();
  return <span>{`${now.getHours()}:${now.getMinutes()}`}</span>;
}

describe("useNow", () => {
  // qa: CAL-14:3
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

  it("is current as soon as a hidden Activity shows it again", () => {
    // The calendar sits in a hidden Activity while the editor shows, which stops its
    // timer and listeners, so the focus that brings the window back reaches nothing.
    vi.setSystemTime(new Date("2026-03-31T12:00:30.000"));
    const { container, rerender } = render(
      <Activity mode="visible">
        <Clock />
      </Activity>
    );
    rerender(
      <Activity mode="hidden">
        <Clock />
      </Activity>
    );

    vi.setSystemTime(new Date("2026-03-31T12:20:10.000"));
    rerender(
      <Activity mode="visible">
        <Clock />
      </Activity>
    );
    expect(container).toHaveTextContent("12:20");
  });

  it("is current within seconds when a timer stalled, as through the Mac's sleep", async () => {
    // A sleeping Mac pauses timers, so one set for the next minute fires that much late.
    vi.setSystemTime(new Date("2026-03-31T12:00:30.000"));
    const { result } = renderHook(() => useNow());

    vi.setSystemTime(new Date("2026-03-31T12:40:00.000"));
    await act(() => vi.advanceTimersByTime(5_000));
    expect(result.current.getMinutes()).toBe(40);
  });

  it("runs one timer however many read it", () => {
    vi.setSystemTime(new Date("2026-03-31T12:00:30.000"));
    render(
      <>
        <Clock />
        <Clock />
        <Clock />
      </>
    );
    expect(vi.getTimerCount()).toBe(1);
  });

  it("moves every reader to the same minute", async () => {
    vi.setSystemTime(new Date("2026-03-31T12:00:30.000"));
    const { container } = render(
      <>
        <Clock />
        <Clock />
      </>
    );

    await act(() => vi.advanceTimersByTime(30_000));
    expect(container).toHaveTextContent("12:112:1");
  });

  it("doesn't render a fresh mount twice within the minute", () => {
    vi.setSystemTime(new Date("2026-03-31T12:00:30.000"));
    let renders = 0;
    renderHook(() => {
      renders += 1;
      return useNow();
    });
    expect(renders).toBe(1);
  });

  it("stops its timers on unmount", () => {
    vi.setSystemTime(new Date("2026-03-31T12:00:30.000"));
    const { unmount } = renderHook(() => useNow());
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
