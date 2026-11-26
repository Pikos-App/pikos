import { useRef, useState } from "react";

interface AllDayCreatePreview {
  startDayIndex: number;
  endDayIndex: number;
  /** True once the cursor has moved past the click-jitter threshold. */
  moved: boolean;
}

export interface UseAllDayCreateOptions {
  days: Date[];
  dayColumnsRef: React.RefObject<HTMLDivElement | null>;
  /** Called on release. A plain click passes only `start`. */
  onCreateAllDay: (start: Date, end?: Date) => Promise<void> | void;
  disableSelect: (cursor: "dragging-grab" | "dragging-resize") => void;
  enableSelect: () => void;
  /** Swallows the click that follows release so it doesn't open what's under the pointer. */
  eatNextClick: () => void;
}

export interface UseAllDayCreateResult {
  allDayCreatePreview: AllDayCreatePreview | null;
  handleAllDayCreateDragStart: (args: {
    clientX: number;
    clientY: number;
    dayIndex: number;
  }) => void;
}

/** Moving less than this many pixels counts as a click. */
const CLICK_JITTER_PX = 4;

/**
 * Press-drag-release in the all-day strip creates an all-day page: a click makes one day,
 * a drag a multi-day span. The ghost is an overlay, not a PageSummary, so it stays out of
 * row assignment and the popover doesn't open-close-open.
 */
export function useAllDayCreate({
  dayColumnsRef,
  days,
  disableSelect,
  eatNextClick,
  enableSelect,
  onCreateAllDay,
}: UseAllDayCreateOptions): UseAllDayCreateResult {
  const allDayCreatePreviewRef = useRef<AllDayCreatePreview | null>(null);
  const [allDayCreatePreview, setAllDayCreatePreview] = useState<AllDayCreatePreview | null>(null);

  function dayIndexFromClientX(clientX: number): number | null {
    const columnsEl = dayColumnsRef.current;
    if (!columnsEl) return null;
    const rect = columnsEl.getBoundingClientRect();
    const columnWidth = rect.width / days.length;
    return Math.max(0, Math.min(days.length - 1, Math.floor((clientX - rect.left) / columnWidth)));
  }

  function handleAllDayCreateDragStart({
    clientX,
    dayIndex,
  }: {
    clientX: number;
    clientY: number;
    dayIndex: number;
  }) {
    disableSelect("dragging-grab");
    allDayCreatePreviewRef.current = {
      endDayIndex: dayIndex,
      moved: false,
      startDayIndex: dayIndex,
    };
    // The ghost lands at the clicked column's first free row, where the chip will mount.
    setAllDayCreatePreview({ endDayIndex: dayIndex, moved: false, startDayIndex: dayIndex });
    const originClientX = clientX;

    function onMove(ev: PointerEvent) {
      if (!ev.isPrimary) return;
      const state = allDayCreatePreviewRef.current;
      if (!state) return;
      const idx = dayIndexFromClientX(ev.clientX);
      if (idx === null) return;
      const moved =
        state.moved ||
        Math.abs(ev.clientX - originClientX) > CLICK_JITTER_PX ||
        idx !== state.startDayIndex;
      if (state.endDayIndex === idx && state.moved === moved) return;
      const next = { endDayIndex: idx, moved, startDayIndex: state.startDayIndex };
      allDayCreatePreviewRef.current = next;
      setAllDayCreatePreview(next);
    }

    function onUp(ev: PointerEvent) {
      if (!ev.isPrimary) return;
      teardown();
      enableSelect();
      eatNextClick();
      const state = allDayCreatePreviewRef.current;
      allDayCreatePreviewRef.current = null;
      setAllDayCreatePreview(null);
      if (!state) return;
      const lo = Math.min(state.startDayIndex, state.endDayIndex);
      const hi = Math.max(state.startDayIndex, state.endDayIndex);
      const startDay = days[lo];
      const endDay = days[hi];
      if (!startDay || !endDay) return;
      void onCreateAllDay(startDay, state.moved && lo !== hi ? endDay : undefined);
    }

    function onCancel(ev: PointerEvent) {
      if (!ev.isPrimary) return;
      teardown();
      enableSelect();
      allDayCreatePreviewRef.current = null;
      setAllDayCreatePreview(null);
    }

    function teardown() {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
    }

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
  }

  return { allDayCreatePreview, handleAllDayCreateDragStart };
}
