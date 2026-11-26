import { CLICK_DELAY } from "@pikos/core";
import { useEffect, useRef, useState } from "react";

import { useUI } from "@/shared/context/UIContext";

export interface UseCalendarBlockPopoverOptions {
  /** Opens the popover on mount, or when this later flips to true. */
  autoOpenPopover?: boolean | undefined;
  onAutoOpenConsumed?: (() => void) | undefined;
  onDoubleClick: () => void;
}

export interface UseCalendarBlockPopoverResult {
  popoverOpen: boolean;
  setPopoverOpen: (open: boolean) => void;
  handlePopoverOpenChange: (open: boolean) => void;
  handleClick: (e: React.MouseEvent) => void;
  handleContextMenu: (e: React.MouseEvent) => void;
  /** Cancels a pending single-click; call from checkbox and edge-resize presses. */
  suppressPendingClick: () => void;
  /**
   * Marks a drag in progress; the click that ends it on the block is swallowed. The mark clears
   * on pointer release, not on that click: a gesture released off the block sends no click,
   * and the mark would eat the user's next real one.
   */
  markDragging: () => void;
}

/**
 * Popover and click-gesture logic shared by timed PageBlock and all-day AllDayBar. Pointerdown
 * handlers stay per block: body-drag waits for the threshold, edge-resize fires at once.
 */
export function useCalendarBlockPopover(
  opts: UseCalendarBlockPopoverOptions
): UseCalendarBlockPopoverResult {
  const { rightPanel } = useUI();
  const [popoverOpen, setPopoverOpen] = useState(opts.autoOpenPopover ?? false);
  const [autoOpenHandled, setAutoOpenHandled] = useState(opts.autoOpenPopover ?? false);
  // The block may mount before the parent's autoOpenPageId commits, so latch the rising edge
  // via the render-time derived-state pattern.
  if (opts.autoOpenPopover && !autoOpenHandled) {
    setAutoOpenHandled(true);
    setPopoverOpen(true);
  }
  // The calendar is hidden, not unmounted, when the editor takes over the right panel; its
  // trigger collapses to 0×0 and a portaled popover would float at (0, 0).
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
    if (draggingRef.current) return;
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

  function handleContextMenu(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    suppressPendingClick();
    setPopoverOpen(true);
  }

  function suppressPendingClick() {
    if (clickTimerRef.current !== null) {
      clearTimeout(clickTimerRef.current);
      clickTimerRef.current = null;
    }
  }

  function markDragging() {
    draggingRef.current = true;
    const gesture = new AbortController();
    // A timeout, so the click the release dispatches still finds the mark.
    const release = () => {
      // Stryker disable next-line CallExpression: left attached, the listener only clears an already-clear mark
      gesture.abort();
      setTimeout(() => {
        draggingRef.current = false;
      }, 0);
    };
    // Stryker disable next-line ObjectLiteral,BooleanLiteral: nothing stops a pointerup before the window today
    const options = { capture: true, signal: gesture.signal };
    window.addEventListener("pointerup", release, options);
    window.addEventListener("pointercancel", release, options);
  }

  return {
    handleClick,
    handleContextMenu,
    handlePopoverOpenChange,
    markDragging,
    popoverOpen,
    setPopoverOpen,
    suppressPendingClick,
  };
}
