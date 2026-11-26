import type { CollapseGeometry } from "@pikos/core";
import { mapHourToY, mapYToHour, VISIBLE_HOURS } from "@pikos/core";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { STORAGE_KEYS } from "@/shared/constants/storage";
import { getKeyValueStore } from "@/shared/kv";

const SCROLL_PERSIST_DEBOUNCE_MS = 200;

/** Values under 0.5h are treated as unset: a persisted scrollHour=0 would pin the calendar to midnight. */
const MIN_USABLE_SAVED_HOUR = 0.5;

export interface UseScrollPersistOptions {
  calendarScrollRequest: { hour: number; token: number } | null;
  geometry: CollapseGeometry;
  rightPanel: string;
  storageKey?: string;
}

export interface UseScrollPersistResult {
  scrollRef: React.RefObject<HTMLDivElement | null>;
  containerHeight: number;
}

/**
 * Persists the WeekGrid scroll position as an hour offset (0-24), independent of density,
 * debounced on scroll.
 *
 * Restore runs each time rightPanel becomes "calendar" with a measured height, not once per
 * hook lifetime: the calendar mounts behind `hidden` with containerHeight=0 and would never
 * restore. A per-session latch stops resize or geometry changes re-pinning the user's scroll.
 * A view-in-calendar request (single-use token) scrolls to its hour; a plain reveal uses the
 * saved hour, else max(7am, currentHour - 1).
 */
export function useScrollPersist({
  calendarScrollRequest,
  geometry,
  rightPanel,
  storageKey = STORAGE_KEYS.calendarScrollHour,
}: UseScrollPersistOptions): UseScrollPersistResult {
  const scrollRef = useRef<HTMLDivElement>(null);

  // Measured so callers can inflate hour rows when the viewport is taller than the grid.
  const [containerHeight, setContainerHeight] = useState(0);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    setContainerHeight(el.clientHeight);
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) setContainerHeight(entry.contentRect.height);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // The calendar container has clientHeight=0 while `hidden`, and ResizeObserver isn't guaranteed
  // to re-fire on display: none -> block, so remeasure when the panel becomes visible.
  useLayoutEffect(() => {
    if (rightPanel !== "calendar") return;
    const el = scrollRef.current;
    if (!el) return;
    if (el.clientHeight > 0 && el.clientHeight !== containerHeight) {
      setContainerHeight(el.clientHeight);
    }
  }, [rightPanel, containerHeight]);

  // Gated by the per-session latch (see above); a fresh view-in-calendar token bypasses it.
  const restoredForSessionRef = useRef(false);
  const lastConsumedScrollTokenRef = useRef<number | null>(null);
  useEffect(() => {
    if (rightPanel !== "calendar") {
      restoredForSessionRef.current = false;
      return;
    }
    if (containerHeight === 0) return;
    const el = scrollRef.current;
    if (!el) return;

    if (
      calendarScrollRequest !== null &&
      calendarScrollRequest.token !== lastConsumedScrollTokenRef.current
    ) {
      el.scrollTop = mapHourToY(calendarScrollRequest.hour, geometry);
      lastConsumedScrollTokenRef.current = calendarScrollRequest.token;
      restoredForSessionRef.current = true;
      return;
    }

    if (restoredForSessionRef.current) return;
    restoredForSessionRef.current = true;

    const raw = getKeyValueStore().getItem(storageKey);
    const saved = raw !== null ? Number(raw) : NaN;
    const hasUsableSaved = Number.isFinite(saved) && saved >= MIN_USABLE_SAVED_HOUR;
    const scrollHour = hasUsableSaved
      ? Math.min(saved, VISIBLE_HOURS)
      : Math.max(7, new Date().getHours() - 1);
    el.scrollTop = mapHourToY(scrollHour, geometry);
  }, [calendarScrollRequest, containerHeight, geometry, rightPanel, storageKey]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    let tid: ReturnType<typeof setTimeout> | null = null;
    function handle() {
      if (!el) return;
      if (tid !== null) clearTimeout(tid);
      tid = setTimeout(() => {
        const scrollHour = mapYToHour(el.scrollTop, geometry);
        getKeyValueStore().setItem(storageKey, String(scrollHour));
      }, SCROLL_PERSIST_DEBOUNCE_MS);
    }
    el.addEventListener("scroll", handle, { passive: true });
    return () => {
      el.removeEventListener("scroll", handle);
      if (tid !== null) clearTimeout(tid);
    };
  }, [geometry, storageKey]);

  return { containerHeight, scrollRef };
}
