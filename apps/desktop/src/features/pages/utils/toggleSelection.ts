import type { PageStatus } from "@pikos/core";

export interface ToggleSelectionGroups<T> {
  /** Non-recurring, currently-open page ids to mark done. */
  toComplete: string[];
  /** Non-recurring, currently-done page ids to reopen. */
  toUncomplete: string[];
  /** Recurring pages — completion clones + advances the head, so it can't be a
   *  plain status flip; these keep routing through the per-page recurring path. */
  recurring: T[];
}

/**
 * Split a multi-selection into the groups `toggleSelected` dispatches. Toggle
 * semantics are preserved per page (done ↔ not_started), but non-recurring
 * flips are batched so they can be written in ONE transaction per status group
 * instead of N concurrent writes that race the WAL pool (QA §4: "Space doesn't
 * reliably complete all").
 */
export function partitionToggleSelection<T extends { id: string; status: PageStatus }>(
  selected: readonly T[],
  isRecurring: (pageId: string) => boolean
): ToggleSelectionGroups<T> {
  const toComplete: string[] = [];
  const toUncomplete: string[] = [];
  const recurring: T[] = [];
  for (const page of selected) {
    if (isRecurring(page.id)) {
      recurring.push(page);
    } else if (page.status === "done") {
      toUncomplete.push(page.id);
    } else {
      toComplete.push(page.id);
    }
  }
  return { recurring, toComplete, toUncomplete };
}
