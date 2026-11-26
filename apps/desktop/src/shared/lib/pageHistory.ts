/**
 * Back and forward through opened pages. Only opening a page is a step: switching folders, moving
 * the calendar's week and opening a dialog are not. Arrowing through the list is browsing, so a
 * run of arrow steps is one entry: Back from the end returns to where the run started.
 */

interface Entry {
  browsed: boolean;
  id: string;
}

export interface PageHistory {
  entries: Entry[];
  index: number;
}

const MAX_ENTRIES = 100;

export const EMPTY_PAGE_HISTORY: PageHistory = { entries: [], index: -1 };

export function visitPage(
  history: PageHistory,
  id: string,
  { browsed = false, showing = null }: { browsed?: boolean; showing?: string | null } = {}
): PageHistory {
  const missesShowing = showing !== null && history.entries[history.index]?.id !== showing;
  const from = missesShowing ? visitPage(history, showing) : history;
  const current = from.entries[from.index];

  if (current?.id === id) return from;

  const continuesBrowsing = browsed && current?.browsed === true;
  const kept = from.entries.slice(0, continuesBrowsing ? from.index : from.index + 1);
  const entries = [...kept, { browsed, id }].slice(-MAX_ENTRIES);

  return { entries, index: entries.length - 1 };
}

export function pageHistoryIds(history: PageHistory): string[] {
  return history.entries.map((entry) => entry.id);
}

/**
 * The nearest open page in `direction`, or null when there is none. With the page closed, Back
 * first returns to it.
 */
export function stepPageHistory(
  history: PageHistory,
  showing: string | null,
  direction: -1 | 1,
  isOpen: (id: string) => boolean
): { history: PageHistory; id: string } | null {
  const standsOnShowing = history.entries[history.index]?.id === showing;
  const start = !standsOnShowing && direction === -1 ? history.index : history.index + direction;

  for (let index = start; index >= 0 && index < history.entries.length; index += direction) {
    const entry = history.entries[index];
    if (entry && isOpen(entry.id)) {
      return { history: { entries: history.entries, index }, id: entry.id };
    }
  }

  return null;
}
