import type { VirtualRow } from "@pikos/core";
import type { Virtualizer } from "@tanstack/react-virtual";
import { type RefObject, useEffect, useLayoutEffect, useRef } from "react";

interface Seen {
  /** Each row on screen, by key, with its index then. */
  indexOf: Map<string, number>;
  /** How far the first of them sat below the top. */
  delta: number;
  firstKey: string;
  data: string;
}

/** How far most of the rows that were on screen moved, by index; null when none are left. */
export function listShift(indexOf: Map<string, number>, rows: VirtualRow[]): number | null {
  const now = new Map(rows.map((r, i) => [r.key, i]));
  const shifts = new Map<number, number>();
  for (const [key, index] of indexOf) {
    const at = now.get(key);
    if (at !== undefined) shifts.set(at - index, (shifts.get(at - index) ?? 0) + 1);
  }
  const [best] = [...shifts.entries()].sort((a, b) => b[1] - a[1]);
  return best ? best[0] : null;
}

/**
 * Keeps a refreshed list still: after rows change, scrolls so the rows that were on screen and
 * stayed in place relative to each other sit where they were. The shift most of those rows moved
 * by is the list's; a row that moved by any other amount moved itself, and is never followed.
 * With none of them left, the offset stays as it was. Only a change of `data`, the rows loaded,
 * moves the scroll: rows shifting because a section was expanded are the user's own doing.
 */
export function useScrollAnchor(
  listRef: RefObject<HTMLDivElement | null>,
  virtualizer: Virtualizer<HTMLDivElement, Element>,
  rows: VirtualRow[],
  data: string | null
): void {
  const seen = useRef<Seen | null>(null);
  const items = virtualizer.getVirtualItems();
  const onScreen = items.map((item) => rows[item.index]?.key ?? "").join("\n");

  useLayoutEffect(() => {
    const el = listRef.current;
    const before = seen.current;
    if (data === null || !el || !before || before.data === data) return;
    const shift = listShift(before.indexOf, rows);
    if (shift === null || shift === 0) return;
    const firstIndex = before.indexOf.get(before.firstKey);
    const target =
      firstIndex === undefined ? undefined : virtualizer.measurementsCache[firstIndex + shift];
    if (target) virtualizer.scrollToOffset(target.start - before.delta);
  }, [onScreen]);

  // Remember what's on screen after every render, for the next change to anchor on.
  useEffect(() => {
    const el = listRef.current;
    const first = items.find((item) => item.end > (el?.scrollTop ?? 0));
    if (!el || !first) {
      seen.current = null;
      return;
    }
    seen.current = {
      data: data ?? "",
      delta: first.start - el.scrollTop,
      firstKey: rows[first.index]?.key ?? "",
      indexOf: new Map(items.map((item) => [rows[item.index]?.key ?? "", item.index])),
    };
  });
}
