import { useRef, useState } from "react";

import { type CollapseGeometry, mapYToDate } from "../utils/calendarGeometry";
import { formatTimeRange } from "../utils/calendarTimeFormat";

export interface GhostContent {
  folderColor: string | undefined;
  height: number;
  isCompact: boolean;
  isDone: boolean;
  title: string;
}

export interface UseDragGhostOptions {
  days: Date[];
  geometry: CollapseGeometry;
  dayColumnsRef: React.RefObject<HTMLDivElement | null>;
}

export interface UseDragGhostResult {
  ghostContent: GhostContent | null;
  setGhostContent: (next: GhostContent | null) => void;
  ghostRefCallback: (el: HTMLDivElement | null) => void;
  ghostTimeLabelRefCallback: (el: HTMLParagraphElement | null) => void;
  positionGhost: (dayIndex: number, top: number, height: number) => void;
  showGhost: () => void;
  hideGhost: () => void;
  /** Caller records the desired initial position before triggering the
   * React render that mounts the ghost. The ref callback applies it the
   * moment the ghost element exists. */
  queueInitialPosition: (dayIndex: number, top: number, height: number) => void;
}

/**
 * Owns the shared drag-ghost overlay: content state plus imperative DOM ops
 * (positionGhost/showGhost/hideGhost) invoked from each drag hook's
 * mousemove, and queueInitialPosition for the "ghost mounted with no
 * mousemove yet" case at gesture start.
 *
 * Refs are not exposed in the result object — react-compiler treats hook
 * outputs as immutable, so mutating refs read off them would lint-fail.
 * The drag hooks call the exposed functions instead.
 */
export function useDragGhost({
  dayColumnsRef,
  days,
  geometry,
}: UseDragGhostOptions): UseDragGhostResult {
  const [ghostContent, setGhostContent] = useState<GhostContent | null>(null);
  const ghostElRef = useRef<HTMLDivElement | null>(null);
  const ghostTimeLabelRef = useRef<HTMLParagraphElement | null>(null);
  const pendingPositionRef = useRef<{
    dayIndex: number;
    top: number;
    height: number;
  } | null>(null);

  function positionGhost(dayIndex: number, top: number, height: number) {
    const el = ghostElRef.current;
    const cols = dayColumnsRef.current;
    if (!el || !cols) return;
    const colW = cols.clientWidth / days.length;
    el.style.left = `${dayIndex * colW + 2}px`;
    el.style.top = `${top}px`;
    el.style.width = `${colW - 4}px`;
    el.style.height = `${height}px`;
    if (ghostTimeLabelRef.current) {
      const day = days[dayIndex];
      if (day) {
        ghostTimeLabelRef.current.textContent = formatTimeRange(
          mapYToDate(top, day, geometry),
          mapYToDate(top + height, day, geometry)
        );
      }
    }
  }

  function hideGhost() {
    if (ghostElRef.current) ghostElRef.current.style.display = "none";
  }

  function showGhost() {
    if (ghostElRef.current) ghostElRef.current.style.display = "";
  }

  function queueInitialPosition(dayIndex: number, top: number, height: number) {
    pendingPositionRef.current = { dayIndex, height, top };
  }

  function ghostRefCallback(el: HTMLDivElement | null) {
    ghostElRef.current = el;
    const pending = pendingPositionRef.current;
    if (el && pending) {
      positionGhost(pending.dayIndex, pending.top, pending.height);
      pendingPositionRef.current = null;
    }
  }

  function ghostTimeLabelRefCallback(el: HTMLParagraphElement | null) {
    ghostTimeLabelRef.current = el;
  }

  return {
    ghostContent,
    ghostRefCallback,
    ghostTimeLabelRefCallback,
    hideGhost,
    positionGhost,
    queueInitialPosition,
    setGhostContent,
    showGhost,
  };
}
