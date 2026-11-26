import { folderIdForNewPage, storageErrorUserMessage, toStorageError } from "@pikos/core";
import { format } from "date-fns";

import { useAppSettings } from "@/shared/context/AppSettingsContext";
import { usePages } from "@/shared/context/PagesContext";
import { useUI } from "@/shared/context/UIContext";
import { useUndoDelete } from "@/shared/context/UndoDeleteContext";
import { createLogger } from "@/shared/logger";

const log = createLogger("useCalendarPageCreate");

export interface UseCalendarPageCreateResult {
  createTimedPage: (start: Date, end?: Date) => Promise<void>;
  createAllDayPage: (start: Date, end?: Date) => Promise<void>;
}

/**
 * The write behind both grid create gestures, given a callback to auto-open what it creates.
 *
 * Resolves the folder through `folderIdForNewPage` rather than the active view id, so a
 * selected synced calendar falls to a folder that can hold pages. Any other refusal is
 * reported (a bare await surfaced nowhere), and a page created before the failure is taken
 * back out.
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
      // Only the create leg needs a message here: scheduleOnce names its own failure, and posting
      // again would raise two toasts.
      if (!created) showNotice(storageErrorUserMessage(toStorageError(e), "creating the page"));
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
