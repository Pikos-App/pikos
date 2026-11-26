// App-wide page and folder deletion with undo. Items are soft-deleted in the DB and hidden
// immediately; Undo restores them. When the toast timer expires only local pending/hidden state
// is cleared, with no further DB write. Deleting the active page also clears the editor.

import type { Folder, PageSummary } from "@pikos/core";
import { createContext, type ReactNode, useContext, useEffect, useRef, useState } from "react";

import type { ToastItem } from "@/shared/components/Toast";
import { usePages } from "@/shared/context/PagesContext";
import { useUI } from "@/shared/context/UIContext";
import { subscribeNotices } from "@/shared/events/noticeBus";
import { useKeyboardShortcut } from "@/shared/keyboard/useKeyboard";
import { quoteTitle } from "@/shared/utils/quoteTitle";
import { usePageLookup } from "@/shared/viewCache/useHeldPages";

export interface UndoDeleteContextValue {
  requestDeletePage: (page: Pick<PageSummary, "id" | "title">) => void;
  requestDeletePages: (pages: Pick<PageSummary, "id" | "title">[]) => void;
  requestDeleteFolder: (folder: Folder, pageCount: number) => void;
  hiddenPageIds: Set<string>;
  hiddenFolderIds: Set<string>;
  toastItems: ToastItem[];
  /** Called by Toast when the timer expires: clears local pending/hidden state only. */
  handleToastDismiss: (id: string) => void;

  requestUndoableAction: (id: string, label: string, undoFn: () => void) => void;

  showNotice: (label: string, durationMs?: number) => void;

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
    // Close the editor if about to hide the active page, or it keeps rendering a page that no longer
    // exists in any list.
    if (activePageId && ids.includes(activePageId)) setActivePage(null);
    setHiddenPageIds((prev) => new Set([...prev, ...ids]));
    const label = isSingle
      ? `Deleted ${quoteTitle(first.title)}`
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
    // Close the editor if the active page lives inside the folder about to be hidden.
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
        label: `Deleted ${quoteTitle(folder.name)}${suffix}`,
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

  // Bridge module-level postNotice() calls (Tiptap extensions, Tauri drop handlers) into the toast
  // surface.
  useEffect(() => subscribeNotices(showNotice), []);

  // Cmd+Z fires the most recent undoable toast's action, skipped in a text input or contentEditable
  // so the editor's native undo keeps working. Gated on there being one, so the palette doesn't
  // offer an undo with nothing to act on.
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
    {
      group: "Navigation",
      label: "Undo delete",
      when: () => toastItems.some((toast) => toast.action),
    }
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
