import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { VISIBLE_HOURS } from "../utils/calendarConstants";
import { type CollapseGeometry, mapHourToY, mapYToHour } from "../utils/calendarGeometry";

const SCROLL_STORAGE_KEY = "pikos:calendarScrollHour";
const SCROLL_PERSIST_DEBOUNCE_MS = 200;

/** Values under 0.5h are treated as unset. An earlier scroll-clamp bug on
 * tall monitors persisted scrollHour=0, which would otherwise pin the
 * calendar to midnight on every subsequent open. */
const MIN_USABLE_SAVED_HOUR = 0.5;

export interface UseScrollPersistOptions {
  /** One-shot view-in-calendar target. When non-null and `token` hasn't been
   * consumed yet, restore scrolls to `hour` and records the token. */
  calendarScrollRequest: { hour: number; token: number } | null;
  /** Current collapse-aware geometry — used to convert saved hour ↔ pixel. */
  geometry: CollapseGeometry;
  /** Right-panel value from UIContext. Restore re-arms each time this flips
   * to "calendar"; resets the per-session latch when it flips away. */
  rightPanel: string;
  /** Storage key override (test seam). Defaults to "pikos:calendarScrollHour". */
  storageKey?: string;
}

export interface UseScrollPersistResult {
  /** Bind to the scroll container's ref. */
  scrollRef: React.RefObject<HTMLDivElement | null>;
  /** Measured scroll-container clientHeight. 0 until the first measurement. */
  containerHeight: number;
}

/**
 * Scroll position persistence for the WeekGrid time grid.
 *
 * Stores scroll position as an hour offset (0–24) so the saved value is
 * independent of density. Persists on scroll (debounced) and re-reads
 * container height when the panel becomes visible (EditorPanel uses `hidden`,
 * not unmount, to toggle).
 *
 * Two restore paths:
 *   1. View-in-calendar request → scroll to the requested hour (single-use,
 *      keyed by token so re-triggering the same hour still works).
 *   2. Plain reveal → saved scrollHour, else smart-start at
 *      max(7am, currentHour − 1) so "now" is visible without burying it.
 *
 * Restore runs each time rightPanel transitions to "calendar" with a measured
 * height — not just once per hook lifetime. Earlier "once per lifetime"
 * behaviour broke cold launches where containerHeight=0 on initial mount
 * (calendar behind `hidden`) and the effect never re-fired after unhide.
 * A per-session ref suppresses restore from re-firing on the same calendar
 * reveal when containerHeight or geometry change (e.g. window resize), so
 * the user's in-session scroll is preserved.
 */
export function useScrollPersist({
  calendarScrollRequest,
  geometry,
  rightPanel,
  storageKey = SCROLL_STORAGE_KEY,
}: UseScrollPersistOptions): UseScrollPersistResult {
  const scrollRef = useRef<HTMLDivElement>(null);

  // Measure the scroll container so callers can inflate hour rows when the
  // viewport is taller than the base grid height. 0 until the first measurement.
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

  // EditorPanel toggles panels via `hidden` (both mounted), so on first load
  // the calendar container has clientHeight=0 and ResizeObserver isn't guaranteed
  // to re-fire when `display: none → block`. Remeasure explicitly when the
  // panel becomes visible so the scroll-restore effect has a real height to
  // work with.
  useLayoutEffect(() => {
    if (rightPanel !== "calendar") return;
    const el = scrollRef.current;
    if (!el) return;
    if (el.clientHeight > 0 && el.clientHeight !== containerHeight) {
      setContainerHeight(el.clientHeight);
    }
  }, [rightPanel, containerHeight]);

  // Restore is gated by a per-session latch so resize-driven geometry /
  // containerHeight changes never re-pin the user's in-session scroll. The
  // latch resets when rightPanel leaves "calendar", re-arming restore for the
  // next reveal. View-in-calendar requests bypass the latch via the token
  // ref — a fresh token forces a scroll even if a session restore already
  // happened this reveal.
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

    const raw = localStorage.getItem(storageKey);
    const saved = raw !== null ? Number(raw) : NaN;
    const hasUsableSaved = Number.isFinite(saved) && saved >= MIN_USABLE_SAVED_HOUR;
    const scrollHour = hasUsableSaved
      ? Math.min(saved, VISIBLE_HOURS)
      : Math.max(7, new Date().getHours() - 1);
    el.scrollTop = mapHourToY(scrollHour, geometry);
  }, [calendarScrollRequest, containerHeight, geometry, rightPanel, storageKey]);

  // Persist scrollHour on scroll (debounced).
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    let tid: ReturnType<typeof setTimeout> | null = null;
    function handle() {
      if (!el) return;
      if (tid !== null) clearTimeout(tid);
      tid = setTimeout(() => {
        const scrollHour = mapYToHour(el.scrollTop, geometry);
        localStorage.setItem(storageKey, String(scrollHour));
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
