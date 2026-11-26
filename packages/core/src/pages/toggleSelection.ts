import type { PageStatus } from "../types";

export interface ToggleSelectionGroups<T> {
  /** Non-recurring open pages to mark done. */
  toComplete: string[];
  /** Non-recurring done pages to reopen. */
  toUncomplete: string[];
  /** Recurring pages: completion clones and advances the head, so it isn't a status flip and
   *  keeps the per-page recurring path. */
  recurring: T[];
}

/** Splits a selection into the groups `toggleSelected` dispatches. Non-recurring flips batch into
 * one transaction per status group, since N concurrent writes race the WAL pool and drop some. */
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
