import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { useBlockSettle } from "./useBlockSettle";

describe("useBlockSettle", () => {
  it("settles a block dropped at a new time, and passes the move on", () => {
    const onReschedule = vi.fn();
    const { result } = renderHook(() => useBlockSettle(onReschedule));

    act(() =>
      result.current.rescheduleAndSettle("p1", "2026-10-24T09:00:00", "2026-10-24T10:00:00")
    );

    expect(result.current.settlingPageId).toBe("p1");
    expect(onReschedule).toHaveBeenCalledWith(
      "p1",
      "2026-10-24T09:00:00",
      "2026-10-24T10:00:00",
      undefined
    );
  });

  it("stops settling once the animation ends", () => {
    const { result } = renderHook(() => useBlockSettle(vi.fn()));

    act(() => result.current.rescheduleAndSettle("p1", "2026-10-24T09:00:00"));
    act(() => result.current.clearSettling());

    expect(result.current.settlingPageId).toBeNull();
  });

  it("settles nothing when a block is dropped on the all-day strip", () => {
    const onReschedule = vi.fn();
    const { result } = renderHook(() => useBlockSettle(onReschedule));

    act(() => result.current.rescheduleAndSettle("p1", "2026-10-24"));

    expect(result.current.settlingPageId).toBeNull();
    expect(onReschedule).toHaveBeenCalledOnce();
  });

  it("settles nothing for a moved occurrence, whose series' other blocks share its id", () => {
    const { result } = renderHook(() => useBlockSettle(vi.fn()));

    act(() =>
      result.current.rescheduleAndSettle("head", "2026-10-24T09:00:00", undefined, "2026-10-23")
    );

    expect(result.current.settlingPageId).toBeNull();
  });
});
