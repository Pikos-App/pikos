// UndoDeleteContext — app-wide page/folder deletion with undo.
// Items are soft-deleted in the DB and hidden from the UI immediately; the
// toast's Undo action restores them (restorePage/restoreFolder). When the
// toast timer expires, only local pending/hidden state is cleared — the row
// stays soft-deleted (deleted_at set), no further DB write happens. Deleting
// the active page also clears the editor — no caller-side bookkeeping. Also
// exposes generic helpers (`showNotice`, `requestUndoableAction`) that ride
// the same toast surface.

import type { Folder, PageSummary } from "@pikos/core";
import { createContext, type ReactNode, useContext, useEffect, useRef, useState } from "react";

import type { ToastItem } from "@/shared/components/Toast";
import { usePages } from "@/shared/context/PagesContext";
import { useUI } from "@/shared/context/UIContext";
import { subscribeNotices } from "@/shared/events/noticeBus";
import { useKeyboardShortcut } from "@/shared/keyboard/useKeyboard";
import { usePageLookup } from "@/shared/viewCache/useHeldPages";

export interface UndoDeleteContextValue {
  /** Soft-delete + hide the page immediately; the toast's Undo restores it. */
  requestDeletePage: (page: Pick<PageSummary, "id" | "title">) => void;
  /** As requestDeletePage, for a selection: one toast whose Undo restores every page. */
  requestDeletePages: (pages: Pick<PageSummary, "id" | "title">[]) => void;
  /** Soft-delete + hide the folder and its pages immediately; Undo restores all. */
  requestDeleteFolder: (folder: Folder, pageCount: number) => void;
  /** Set of page IDs currently pending deletion — filter these from all views. */
  hiddenPageIds: Set<string>;
  /** Set of folder IDs currently pending deletion — filter these from all views. */
  hiddenFolderIds: Set<string>;
  toastItems: ToastItem[];
  /** Called by Toast when the visual timer expires — clears local pending/hidden
   *  state only; the soft delete already happened at request time. */
  handleToastDismiss: (id: string) => void;

  requestUndoableAction: (id: string, label: string, undoFn: () => void) => void;

  /** Non-reversible confirmation — shows a toast with no action button. */
  showNotice: (label: string, durationMs?: number) => void;

  // Backwards-compat alias
  /** @deprecated Use hiddenPageIds instead. */
  hiddenIds: Set<string>;
}

const NOTICE_PREFIX = "notice:";
const FOLDER_UNDO_PREFIX = "folder:";
const PAGES_UNDO_PREFIX = "pages:";

const UndoDeleteContext = createContext<UndoDeleteContextValue | null>(null);

export function UndoDeleteProvider({ children }: { children: ReactNode }) {
  const { restoreFolder, restorePage, softDeleteFolder, softDeletePage } = usePages();
  const lookup = usePageLookup();
  const { activePageId, setActivePage } = useUI();

  const pendingDeleteIds = useRef<Set<string>>(new Set());
  const [hiddenPageIds, setHiddenPageIds] = useState<Set<string>>(new Set());
  const [hiddenFolderIds, setHiddenFolderIds] = useState<Set<string>>(new Set());
  const [toastItems, setToastItems] = useState<ToastItem[]>([]);
  const undoCallbacks = useRef<Map<string, () => void>>(new Map());
  const pendingFolderIds = useRef<Set<string>>(new Set());
  const toastPageIds = useRef<Map<string, string[]>>(new Map());

  function removeToast(id: string) {
    setToastItems((prev) => prev.filter((item) => item.id !== id));
  }

  function releasePages(toastId: string): string[] {
    const ids = toastPageIds.current.get(toastId) ?? [toastId];
    toastPageIds.current.delete(toastId);
    for (const id of ids) pendingDeleteIds.current.delete(id);
    setHiddenPageIds((prev) => {
      const next = new Set(prev);
      for (const id of ids) next.delete(id);
      return next;
    });

    return ids;
  }

  function undoPages(toastId: string) {
    for (const id of releasePages(toastId)) void restorePage(id);
    removeToast(toastId);
  }

  function undoFolder(undoId: string) {
    pendingDeleteIds.current.delete(undoId);
    const folderId = undoId.slice(FOLDER_UNDO_PREFIX.length);
    pendingFolderIds.current.delete(folderId);
    setHiddenFolderIds((prev) => {
      const next = new Set(prev);
      next.delete(folderId);
      return next;
    });
    void restoreFolder(folderId);
    removeToast(undoId);
  }

  function requestDeletePages(pages: Pick<PageSummary, "id" | "title">[]) {
    const fresh = pages.filter((p) => !pendingDeleteIds.current.has(p.id));
    const [first] = fresh;
    if (!first) return;

    const ids = fresh.map((p) => p.id);
    const isSingle = ids.length === 1;
    const toastId = isSingle ? first.id : `${PAGES_UNDO_PREFIX}${crypto.randomUUID()}`;
    for (const id of ids) pendingDeleteIds.current.add(id);
    toastPageIds.current.set(toastId, ids);
    // Close the editor if we're about to hide the active page — otherwise the
    // editor keeps rendering a stale page that no longer exists in any list.
    if (activePageId && ids.includes(activePageId)) setActivePage(null);
    setHiddenPageIds((prev) => new Set([...prev, ...ids]));
    const label = isSingle
      ? `Deleted “${first.title || "Untitled"}”`
      : `${ids.length} pages moved to Trash`;
    setToastItems((prev) => [
      ...prev,
      { action: { label: "Undo", onClick: () => undoPages(toastId) }, id: toastId, label },
    ]);
    for (const id of ids) void softDeletePage(id);
  }

  function requestDeletePage(page: Pick<PageSummary, "id" | "title">) {
    requestDeletePages([page]);
  }

  function requestDeleteFolder(folder: Folder, pageCount: number) {
    const undoId = `${FOLDER_UNDO_PREFIX}${folder.id}`;
    if (pendingDeleteIds.current.has(undoId)) return;
    pendingDeleteIds.current.add(undoId);
    pendingFolderIds.current.add(folder.id);
    // Close the editor if the active page lives inside the folder we're about
    // to hide — the cascade soft-delete removes it from the pages list.
    const activePage = activePageId ? lookup(activePageId) : null;
    if (activePage && activePage.folderId === folder.id) setActivePage(null);
    setHiddenFolderIds((prev) => new Set([...prev, folder.id]));
    const suffix = pageCount > 0 ? ` and ${pageCount} ${pageCount === 1 ? "page" : "pages"}` : "";
    setToastItems((prev) => [
      ...prev,
      {
        action: { label: "Undo", onClick: () => undoFolder(undoId) },
        duration: 16000,
        id: undoId,
        label: `Deleted “${folder.name}”${suffix}`,
      },
    ]);
    void softDeleteFolder(folder.id);
  }

  function handleToastDismiss(id: string) {
    pendingDeleteIds.current.delete(id);
    undoCallbacks.current.delete(id);

    if (id.startsWith(NOTICE_PREFIX)) {
      removeToast(id);
      return;
    }

    if (id.startsWith(FOLDER_UNDO_PREFIX)) {
      const folderId = id.slice(FOLDER_UNDO_PREFIX.length);
      pendingFolderIds.current.delete(folderId);
      setHiddenFolderIds((prev) => {
        const next = new Set(prev);
        next.delete(folderId);
        return next;
      });
    } else {
      releasePages(id);
    }

    removeToast(id);
  }

  function requestUndoableAction(id: string, label: string, undoFn: () => void) {
    pendingDeleteIds.current.add(id);
    undoCallbacks.current.set(id, undoFn);
    setToastItems((prev) => [
      ...prev,
      {
        action: {
          label: "Undo",
          onClick: () => {
            pendingDeleteIds.current.delete(id);
            undoCallbacks.current.delete(id);
            undoFn();
            removeToast(id);
          },
        },
        id,
        label,
      },
    ]);
  }

  function showNotice(label: string, durationMs?: number) {
    const id = `${NOTICE_PREFIX}${crypto.randomUUID()}`;
    setToastItems((prev) => [
      ...prev,
      { id, label, ...(durationMs !== undefined ? { duration: durationMs } : {}) },
    ]);
  }

  // Bridge module-level postNotice() calls (Tiptap extensions, Tauri drop
  // handlers — places that can't access React context) into the toast surface.
  useEffect(() => subscribeNotices(showNotice), []);

  // Cmd+Z — fire the most recent undoable toast's action. Skipped while the
  // user is in a text input or contentEditable so the editor's native undo
  // (Tiptap history) keeps working unchanged.
  useKeyboardShortcut(
    "Mod+z",
    () => {
      for (let i = toastItems.length - 1; i >= 0; i--) {
        const toast = toastItems[i];
        if (toast?.action) {
          toast.action.onClick();
          return;
        }
      }
    },
    { group: "Navigation", label: "Undo delete" }
  );

  const value: UndoDeleteContextValue = {
    handleToastDismiss,
    hiddenFolderIds,
    hiddenIds: hiddenPageIds,
    hiddenPageIds,
    requestDeleteFolder,
    requestDeletePage,
    requestDeletePages,
    requestUndoableAction,
    showNotice,
    toastItems,
  };

  return <UndoDeleteContext.Provider value={value}>{children}</UndoDeleteContext.Provider>;
}

// eslint-disable-next-line react-refresh/only-export-components
export function useUndoDelete(): UndoDeleteContextValue {
  const ctx = useContext(UndoDeleteContext);
  if (!ctx) throw new Error("useUndoDelete must be used within <UndoDeleteProvider>");
  return ctx;
}
