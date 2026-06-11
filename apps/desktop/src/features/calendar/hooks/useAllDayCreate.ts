import { useRef, useState } from "react";

interface AllDayCreatePreview {
  startDayIndex: number;
  endDayIndex: number;
  /** True once the cursor has moved past the click-jitter threshold. Used
   * by the renderer to decide between single-day and multi-day previews. */
  moved: boolean;
}

export interface UseAllDayCreateOptions {
  days: Date[];
  /** Refs to the day-columns row — used to translate client X → day index. */
  dayColumnsRef: React.RefObject<HTMLDivElement | null>;
  /** Called on release. The span is materialised here; if `moved` was false
   * (plain click) the caller receives just `start`. */
  onCreateAllDay: (start: Date, end?: Date) => Promise<void> | void;
  /** Lock cursor / userSelect for the duration of the gesture. */
  disableSelect: (cursor: "dragging-grab" | "dragging-resize") => void;
  enableSelect: () => void;
  /** Swallow the click that fires after mouseup so the next click doesn't
   * open whatever's under the cursor. */
  eatNextClick: () => void;
}

export interface UseAllDayCreateResult {
  allDayCreatePreview: AllDayCreatePreview | null;
  /** Bind to mousedown on the all-day row + the day header row. */
  handleAllDayCreateDragStart: (args: {
    clientX: number;
    clientY: number;
    dayIndex: number;
  }) => void;
}

/** Pixel jitter tolerance — moving less than this treats the gesture as a
 * single click and commits a single-day create. */
const CLICK_JITTER_PX = 4;

/**
 * Mousedown-drag-mouseup in the all-day strip creates a new all-day page. A
 * plain click yields a single-day create; a drag across columns yields a
 * multi-day span. Renders an absolute ghost overlay while active so it does
 * NOT participate in row assignment (the overlay is not a PageSummary) —
 * keeps the popover open-close-open dance from firing.
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
    // Ghost renders immediately at the first-free-row of the clicked column
    // (see AllDaySection) so it lands exactly where the real chip will mount
    // on commit — no visual jump between ghost → chip.
    setAllDayCreatePreview({ endDayIndex: dayIndex, moved: false, startDayIndex: dayIndex });
    const originClientX = clientX;

    function onMove(ev: MouseEvent) {
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

    function onUp() {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      enableSelect();
      eatNextClick();
      const state = allDayCreatePreviewRef.current;
      // Clear the ghost overlay synchronously; the create/schedule chain
      // below is fast (setPages is optimistic) so the real chip appears on
      // the next render with minimal gap. The overlay is not a PageSummary,
      // so it doesn't interfere with row assignment or popover anchoring.
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

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  return { allDayCreatePreview, handleAllDayCreateDragStart };
}
