import type { Page } from "@pikos/core";

/** Returns the pages visible for the given view, in sort order. */
export function getVisiblePages(pages: Page[], activeViewId: string): Page[] {
  if (activeViewId === "today") {
    const today = new Date().toISOString().slice(0, 10);
    return pages.filter(
      (p) => p.scheduledStart && p.scheduledStart.slice(0, 10) <= today && p.status !== "done"
    );
  }
  if (activeViewId === "inbox") {
    return pages.filter((p) => p.folderId === null);
  }
  return pages.filter((p) => p.folderId === activeViewId);
}

/** Splits today-view pages into overdue (before today) and today (today only). */
export function groupTodayPages(pages: Page[]): { overdue: Page[]; today: Page[] } {
  const todayStr = new Date().toISOString().slice(0, 10);
  return {
    overdue: pages.filter((p) => p.scheduledStart && p.scheduledStart.slice(0, 10) < todayStr),
    today: pages.filter((p) => p.scheduledStart && p.scheduledStart.slice(0, 10) === todayStr),
  };
}
