import { folderIdForNewPage, storageErrorUserMessage, toStorageError } from "@pikos/core";
import { format } from "date-fns";

import { useAppSettings } from "@/shared/context/AppSettingsContext";
import { usePages } from "@/shared/context/PagesContext";
import { useUI } from "@/shared/context/UIContext";
import { useUndoDelete } from "@/shared/context/UndoDeleteContext";
import { createLogger } from "@/shared/logger";

const log = createLogger("useCalendarPageCreate");

export interface UseCalendarPageCreateResult {
  /** Click or drag in the time grid. */
  createTimedPage: (start: Date, end?: Date) => Promise<void>;
  /** Click or drag in the all-day strip; `end` only for a multi-day span. */
  createAllDayPage: (start: Date, end?: Date) => Promise<void>;
}

/**
 * The write behind both grid create gestures, given a callback to auto-open
 * whatever it creates.
 *
 * Resolves the folder through `folderIdForNewPage` rather than the active view
 * id, so a selected synced calendar falls through to a folder that can hold
 * pages instead of reaching a create the backend refuses. A refusal from any
 * other cause is reported, because a bare await here reached the user as
 * nothing at all and the log as an unhandled promise rejection, and a page
 * created before the failure is taken back out rather than left behind.
 */
export function useCalendarPageCreate(
  onCreated: (pageId: string) => void
): UseCalendarPageCreateResult {
  const { createPage, deletePage, folders, scheduleOnce } = usePages();
  const { activeViewId } = useUI();
  const { defaultFolderId } = useAppSettings();
  const { showNotice } = useUndoDelete();

  async function createScheduled(schedule: (pageId: string) => Promise<void>) {
    const folderId = folderIdForNewPage(activeViewId, folders, defaultFolderId);
    let created: string | null = null;
    try {
      const page = await createPage({ folderId });
      created = page.id;
      await schedule(page.id);
      onCreated(page.id);
    } catch (e) {
      log.error("create from calendar grid failed", e);
      // Two writes, one gesture: a schedule that fails leaves a page nobody asked for, with no
      // title and no date. The usual cleanup for an empty page runs when its popover closes, and
      // the popover only opens on success, so this is the only place that can take it back.
      if (created) await deletePage(created);
      showNotice(storageErrorUserMessage(toStorageError(e), "creating the page"));
    }
  }

  async function createTimedPage(start: Date, end?: Date) {
    // Local-time format (no Z suffix) — SQLite's date() functions require this.
    const fmt = (d: Date) => format(d, "yyyy-MM-dd'T'HH:mm:ss");
    await createScheduled((pageId) => scheduleOnce(pageId, fmt(start), end ? fmt(end) : undefined));
  }

  async function createAllDayPage(start: Date, end?: Date) {
    // Date-only strings → isAllDayPage() returns true.
    await createScheduled((pageId) =>
      scheduleOnce(pageId, format(start, "yyyy-MM-dd"), end ? format(end, "yyyy-MM-dd") : undefined)
    );
  }

  return { createAllDayPage, createTimedPage };
}
