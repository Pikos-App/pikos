import { isTimedIso } from "@pikos/core";
import { useState } from "react";

type Reschedule = (pageId: string, start: string, end?: string, originalDate?: string) => void;

/**
 * Marks the timed block a drag just dropped, so it eases out of the drag
 * ghost's look instead of swapping in for it. Cleared when its animation ends,
 * so the block doesn't play it again the next time it mounts.
 */
export function useBlockSettle(onReschedule: Reschedule) {
  const [settlingPageId, setSettlingPageId] = useState<string | null>(null);

  function rescheduleAndSettle(pageId: string, start: string, end?: string, originalDate?: string) {
    // A moved occurrence lands as a new page, whose id no block has yet.
    const landsAsThisBlock = isTimedIso(start) && !originalDate;
    if (landsAsThisBlock) setSettlingPageId(pageId);

    onReschedule(pageId, start, end, originalDate);
  }

  return {
    clearSettling: () => setSettlingPageId(null),
    rescheduleAndSettle,
    settlingPageId,
  };
}
