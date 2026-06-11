import { format } from "date-fns";
import { useRef, useState } from "react";

import type { BlockResizeStartInfo, ResizeGhost } from "../components/DayColumn";
import { type CalendarMetrics, type CollapseGeometry, mapYToDate } from "../utils/calendarGeometry";
import type { CalendarBlock } from "../utils/calendarLayout";

interface ResizeRefState {
  pageId: string;
  block: CalendarBlock;
  dayIndex: number;
  /** Set when resizing a virtual rrule occurrence — keys the override. */
  originalDate?: string;
}

export interface UseTimedResizeOptions {
  days: Date[];
  geometry: CollapseGeometry;
  metrics: CalendarMetrics;
  scrollRef: React.RefObject<HTMLDivElement | null>;
  onReschedule: (pageId: string, start: string, end?: string, originalDate?: string) => void;
  disableSelect: (cursor: "dragging-grab" | "dragging-resize") => void;
  enableSelect: () => void;
  eatNextClick: () => void;
}

export interface UseTimedResizeResult {
  resizeRenderState: ResizeGhost | null;
  handleBlockResizeStart: (info: BlockResizeStartInfo) => void;
}

/**
 * Owns the bottom-edge resize gesture for timed PageBlocks. Live preview
 * tracks the cursor (no snap) via requestAnimationFrame; commit on release
 * snaps to 15-minute via mapYToDate (collapse-aware).
 */
export function useTimedResize({
  days,
  disableSelect,
  eatNextClick,
  enableSelect,
  geometry,
  metrics,
  onReschedule,
  scrollRef,
}: UseTimedResizeOptions): UseTimedResizeResult {
  const resizeRef = useRef<ResizeRefState | null>(null);
  const resizeGhostBottomRef = useRef<number | null>(null);
  const resizeRafIdRef = useRef(0);
  const [resizeRenderState, setResizeRenderState] = useState<ResizeGhost | null>(null);

  function handleBlockResizeStart({ block, dayIndex, originalDate, pageId }: BlockResizeStartInfo) {
    const scrollEl = scrollRef.current;
    if (!scrollEl) return;

    disableSelect("dragging-resize");
    resizeRef.current = { block, dayIndex, pageId, ...(originalDate && { originalDate }) };
    const initialBottom = block.top + block.height;
    resizeGhostBottomRef.current = initialBottom;
    setResizeRenderState({ bottom: initialBottom, dayIndex, pageId });

    function onMove(ev: MouseEvent) {
      const state = resizeRef.current;
      if (!state || !scrollRef.current) return;

      const scrollEl = scrollRef.current;
      const scrollRect = scrollEl.getBoundingClientRect();
      const cursorYInGrid = ev.clientY - scrollRect.top + scrollEl.scrollTop;
      const minBottom = state.block.top + metrics.minResizeHeight;
      // No snapping during live drag — smooth resize. Snap is applied on
      // commit via mapYToDate.
      const ghostBottom = Math.max(minBottom, Math.min(metrics.gridHeight, cursorYInGrid));

      resizeGhostBottomRef.current = ghostBottom;
      cancelAnimationFrame(resizeRafIdRef.current);
      resizeRafIdRef.current = requestAnimationFrame(() => {
        setResizeRenderState({
          bottom: ghostBottom,
          dayIndex: state.dayIndex,
          pageId: state.pageId,
        });
      });
    }

    function onUp() {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      enableSelect();
      eatNextClick();
      cancelAnimationFrame(resizeRafIdRef.current);

      const state = resizeRef.current;
      const ghostBottom = resizeGhostBottomRef.current;
      resizeRef.current = null;
      resizeGhostBottomRef.current = null;
      setResizeRenderState(null);

      if (!state || ghostBottom === null) return;
      const targetDay = days[state.dayIndex];
      if (!targetDay) return;

      const newEnd = mapYToDate(ghostBottom, targetDay, geometry);
      const fmt = (d: Date) => format(d, "yyyy-MM-dd'T'HH:mm:ss");
      onReschedule(state.pageId, fmt(state.block.startDate), fmt(newEnd), state.originalDate);
    }

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  return { handleBlockResizeStart, resizeRenderState };
}
