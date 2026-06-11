// useCalendarBlockPopover — popover state + click-vs-double-click discrimination
// for calendar blocks. Verifies: auto-open latching, force-close when right
// panel is not calendar, click-delay open, double-click within delay,
// drag-suppression, and timer cleanup on unmount.

import { act } from "@testing-library/react";
import type { MouseEvent as ReactMouseEvent } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useUI } from "@/shared/context/UIContext";
import { renderHookWithProviders } from "@/test/renderWithProviders";

import { CLICK_DELAY } from "../utils/calendarConstants";
import { useCalendarBlockPopover } from "./useCalendarBlockPopover";

beforeEach(() => {
  vi.useFakeTimers();
  // Prime UIContext's persisted rightPanel to "calendar" so the hook's
  // force-close branch (rightPanel !== "calendar" → close) doesn't fire.
  localStorage.clear();
  localStorage.setItem("pikos:rightPanel", JSON.stringify("calendar"));
});
afterEach(() => {
  vi.useRealTimers();
  localStorage.clear();
});

function makeClickEvent(): ReactMouseEvent {
  return {
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
  } as unknown as ReactMouseEvent;
}

describe("useCalendarBlockPopover — auto-open", () => {
  it("does not auto-open when autoOpenPopover is false/undefined", () => {
    const { result } = renderHookWithProviders(() =>
      useCalendarBlockPopover({ onDoubleClick: vi.fn() })
    );
    expect(result.current.popoverOpen).toBe(false);
  });

  it("auto-opens when autoOpenPopover is true on mount", () => {
    const { result } = renderHookWithProviders(() =>
      useCalendarBlockPopover({ autoOpenPopover: true, onDoubleClick: vi.fn() })
    );
    expect(result.current.popoverOpen).toBe(true);
  });

  it("latches on rising edge: false → true after mount also auto-opens", () => {
    const props: { autoOpenPopover: boolean; onDoubleClick: () => void } = {
      autoOpenPopover: false,
      onDoubleClick: vi.fn(),
    };
    const { rerender, result } = renderHookWithProviders((p) => useCalendarBlockPopover(p), {
      initialProps: props,
    });
    expect(result.current.popoverOpen).toBe(false);

    rerender({ autoOpenPopover: true, onDoubleClick: vi.fn() });
    expect(result.current.popoverOpen).toBe(true);
  });

  it("invokes onAutoOpenConsumed when auto-opened popover closes", () => {
    const onAutoOpenConsumed = vi.fn();
    const { result } = renderHookWithProviders(() =>
      useCalendarBlockPopover({
        autoOpenPopover: true,
        onAutoOpenConsumed,
        onDoubleClick: vi.fn(),
      })
    );

    act(() => result.current.handlePopoverOpenChange(false));
    expect(onAutoOpenConsumed).toHaveBeenCalledTimes(1);
  });

  it("does NOT invoke onAutoOpenConsumed when manually opened popover closes", () => {
    const onAutoOpenConsumed = vi.fn();
    const { result } = renderHookWithProviders(() =>
      useCalendarBlockPopover({ onAutoOpenConsumed, onDoubleClick: vi.fn() })
    );

    act(() => result.current.handlePopoverOpenChange(true));
    act(() => result.current.handlePopoverOpenChange(false));
    expect(onAutoOpenConsumed).not.toHaveBeenCalled();
  });
});

describe("useCalendarBlockPopover — force-close on panel switch", () => {
  it("closes the popover when right panel is not calendar", () => {
    const { result } = renderHookWithProviders(() => {
      const ui = useUI();
      const popover = useCalendarBlockPopover({ onDoubleClick: vi.fn() });
      return { popover, ui };
    });

    act(() => result.current.popover.setPopoverOpen(true));
    expect(result.current.popover.popoverOpen).toBe(true);

    act(() => result.current.ui.setRightPanel("editor"));
    expect(result.current.popover.popoverOpen).toBe(false);
  });
});

describe("useCalendarBlockPopover — click discrimination", () => {
  it("single click opens the popover after CLICK_DELAY ms", async () => {
    const { result } = renderHookWithProviders(() =>
      useCalendarBlockPopover({ onDoubleClick: vi.fn() })
    );

    act(() => result.current.handleClick(makeClickEvent()));
    expect(result.current.popoverOpen).toBe(false);

    await act(() => vi.advanceTimersByTime(CLICK_DELAY - 1));
    expect(result.current.popoverOpen).toBe(false);

    await act(() => vi.advanceTimersByTime(1));
    expect(result.current.popoverOpen).toBe(true);
  });

  it("double click within CLICK_DELAY fires onDoubleClick and skips popover", async () => {
    const onDoubleClick = vi.fn();
    const { result } = renderHookWithProviders(() => useCalendarBlockPopover({ onDoubleClick }));

    act(() => result.current.handleClick(makeClickEvent()));
    act(() => result.current.handleClick(makeClickEvent()));
    expect(onDoubleClick).toHaveBeenCalledTimes(1);

    // Advance well past CLICK_DELAY — popover should still be closed.
    await act(() => vi.advanceTimersByTime(CLICK_DELAY * 2));
    expect(result.current.popoverOpen).toBe(false);
  });

  it("two clicks separated by more than CLICK_DELAY both open the popover (each is a single)", async () => {
    const onDoubleClick = vi.fn();
    const { result } = renderHookWithProviders(() => useCalendarBlockPopover({ onDoubleClick }));

    act(() => result.current.handleClick(makeClickEvent()));
    await act(() => vi.advanceTimersByTime(CLICK_DELAY));
    expect(result.current.popoverOpen).toBe(true);
    expect(onDoubleClick).not.toHaveBeenCalled();

    // Close popover, then click again — onDoubleClick should still not fire.
    act(() => result.current.handlePopoverOpenChange(false));
    act(() => result.current.handleClick(makeClickEvent()));
    await act(() => vi.advanceTimersByTime(CLICK_DELAY));
    expect(onDoubleClick).not.toHaveBeenCalled();
    expect(result.current.popoverOpen).toBe(true);
  });

  it("calls preventDefault and stopPropagation on click", () => {
    const { result } = renderHookWithProviders(() =>
      useCalendarBlockPopover({ onDoubleClick: vi.fn() })
    );

    const preventDefault = vi.fn();
    const stopPropagation = vi.fn();
    const ev = { preventDefault, stopPropagation } as unknown as ReactMouseEvent;
    act(() => result.current.handleClick(ev));
    expect(preventDefault).toHaveBeenCalled();
    expect(stopPropagation).toHaveBeenCalled();
  });
});

describe("useCalendarBlockPopover — drag suppression", () => {
  it("a click after markDragging is swallowed (no popover, no double-click)", async () => {
    const onDoubleClick = vi.fn();
    const { result } = renderHookWithProviders(() => useCalendarBlockPopover({ onDoubleClick }));

    act(() => result.current.markDragging());
    act(() => result.current.handleClick(makeClickEvent()));

    // No timer was queued; advancing time does not open the popover.
    await act(() => vi.advanceTimersByTime(CLICK_DELAY * 2));
    expect(result.current.popoverOpen).toBe(false);
    expect(onDoubleClick).not.toHaveBeenCalled();
  });

  it("subsequent clicks after a swallowed drag-click resume normal behaviour", async () => {
    const { result } = renderHookWithProviders(() =>
      useCalendarBlockPopover({ onDoubleClick: vi.fn() })
    );

    act(() => result.current.markDragging());
    act(() => result.current.handleClick(makeClickEvent()));
    // Reset of draggingRef happens in a microtask via setTimeout(0).
    await act(() => vi.advanceTimersByTime(0));

    act(() => result.current.handleClick(makeClickEvent()));
    await act(() => vi.advanceTimersByTime(CLICK_DELAY));
    expect(result.current.popoverOpen).toBe(true);
  });
});

describe("useCalendarBlockPopover — suppressPendingClick", () => {
  it("cancels a pending single-click timer without opening the popover", async () => {
    const { result } = renderHookWithProviders(() =>
      useCalendarBlockPopover({ onDoubleClick: vi.fn() })
    );

    act(() => result.current.handleClick(makeClickEvent()));
    act(() => result.current.suppressPendingClick());

    await act(() => vi.advanceTimersByTime(CLICK_DELAY * 2));
    expect(result.current.popoverOpen).toBe(false);
  });

  it("is a no-op when no click is pending", () => {
    const { result } = renderHookWithProviders(() =>
      useCalendarBlockPopover({ onDoubleClick: vi.fn() })
    );

    expect(() => act(() => result.current.suppressPendingClick())).not.toThrow();
    expect(result.current.popoverOpen).toBe(false);
  });
});

describe("useCalendarBlockPopover — timer cleanup", () => {
  it("clears the pending click timer on unmount", () => {
    const onDoubleClick = vi.fn();
    const { result, unmount } = renderHookWithProviders(() =>
      useCalendarBlockPopover({ onDoubleClick })
    );

    act(() => result.current.handleClick(makeClickEvent()));
    unmount();

    // Past CLICK_DELAY: no errors, no double-fire.
    expect(() => vi.advanceTimersByTime(CLICK_DELAY * 2)).not.toThrow();
  });
});
