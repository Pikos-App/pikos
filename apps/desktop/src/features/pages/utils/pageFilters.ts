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
