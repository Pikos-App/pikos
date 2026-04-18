// useCalendarBlockPopover — shared popover + click-gesture logic for calendar
// blocks (timed PageBlock and all-day AllDayBar). Owns:
//   • popover open state with auto-open rising-edge latch
//   • force-close when the right panel switches away from calendar
//   • click-vs-double-click timer (CLICK_DELAY ms)
//   • post-drag click suppression (swallows the click that fires on mouseup
//     after a drag threshold is crossed)
//   • timer cleanup on unmount
// Each block still owns its own mousedown handlers — body-drag vs edge-
// resize fire with different payloads and the threshold behaviour differs
// (edge-resize fires immediately on mousedown; body-drag waits for the
// threshold). Unifying them further adds more indirection than it saves.

import { useEffect, useRef, useState } from "react";

import { useUI } from "@/shared/context/UIContext";

import { CLICK_DELAY } from "../utils/calendarUtils";

export interface UseCalendarBlockPopoverOptions {
  /** When true, the block mounts with its popover open. The rising-edge latch
   * accepts a `false → true` flip on a later render too, since the block may
   * mount before the parent's autoOpenPageId state commits. */
  autoOpenPopover?: boolean | undefined;
  /** Called once after the auto-opened popover is closed by any path. */
  onAutoOpenConsumed?: (() => void) | undefined;
  /** Fired on a double-click — typically opens the full editor. */
  onDoubleClick: () => void;
}

export interface UseCalendarBlockPopoverResult {
  popoverOpen: boolean;
  setPopoverOpen: (open: boolean) => void;
  /** Bind to Popover's `onOpenChange` — invokes `onAutoOpenConsumed` when the
   * popover closes after having been auto-opened. */
  handlePopoverOpenChange: (open: boolean) => void;
  /** Bind to the block's `onClick` — discriminates single-click (opens
   * popover after CLICK_DELAY) from double-click (fires `onDoubleClick`),
   * and swallows the click fired at the end of a drag gesture. */
  handleClick: (e: React.MouseEvent) => void;
  /** Cancel a pending single-click timer. Call from checkbox + edge-resize
   * mousedowns so the block's click doesn't also open the popover. */
  suppressPendingClick: () => void;
  /** Mark a drag gesture as in progress. The next click event will be
   * swallowed (no popover open, no double-click check). */
  markDragging: () => void;
}

export function useCalendarBlockPopover(
  opts: UseCalendarBlockPopoverOptions
): UseCalendarBlockPopoverResult {
  const { rightPanel } = useUI();
  const [popoverOpen, setPopoverOpen] = useState(opts.autoOpenPopover ?? false);
  const [autoOpenHandled, setAutoOpenHandled] = useState(opts.autoOpenPopover ?? false);
  // Parent may flip autoOpenPopover to true on a later render (the block
  // mounts between scheduleOnce's commit and setAutoOpenPageId's commit), so
  // we latch on the rising edge via the render-time derived-state pattern.
  if (opts.autoOpenPopover && !autoOpenHandled) {
    setAutoOpenHandled(true);
    setPopoverOpen(true);
  }
  // Calendar is hidden (not unmounted) when the editor takes over the right
  // panel. The trigger collapses to a 0×0 box, so a portaled popover would
  // otherwise float next to (0, 0). Force-close on panel switch.
  if (popoverOpen && rightPanel !== "calendar") {
    setPopoverOpen(false);
  }

  const clickTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const draggingRef = useRef(false);

  useEffect(() => {
    return () => {
      if (clickTimerRef.current !== null) clearTimeout(clickTimerRef.current);
    };
  }, []);

  function handlePopoverOpenChange(open: boolean) {
    setPopoverOpen(open);
    if (!open && autoOpenHandled) {
      opts.onAutoOpenConsumed?.();
    }
  }

  function handleClick(e: React.MouseEvent) {
    e.stopPropagation();
    // Radix PopoverTrigger composes onOpenToggle onto onClick; preventDefault
    // suppresses it so the popover opens only via the CLICK_DELAY timer below,
    // not synchronously on the first click of a double-click.
    e.preventDefault();
    if (draggingRef.current) {
      setTimeout(() => {
        draggingRef.current = false;
      }, 0);
      return;
    }
    if (clickTimerRef.current !== null) {
      clearTimeout(clickTimerRef.current);
      clickTimerRef.current = null;
      setPopoverOpen(false);
      opts.onDoubleClick();
      return;
    }
    clickTimerRef.current = setTimeout(() => {
      clickTimerRef.current = null;
      setPopoverOpen(true);
    }, CLICK_DELAY);
  }

  function suppressPendingClick() {
    if (clickTimerRef.current !== null) {
      clearTimeout(clickTimerRef.current);
      clickTimerRef.current = null;
    }
  }

  function markDragging() {
    draggingRef.current = true;
  }

  return {
    handleClick,
    handlePopoverOpenChange,
    markDragging,
    popoverOpen,
    setPopoverOpen,
    suppressPendingClick,
  };
}
