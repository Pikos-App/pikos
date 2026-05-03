"use client";

// UndoDeleteContext — app-wide deferred page/folder deletion with undo.
// Items are hidden from the UI immediately; the real DB delete fires when the
// toast timer expires (onDismiss). Clicking the toast's Undo action cancels the
// pending delete. Deleting the active page also clears the editor — no
// caller-side bookkeeping. Also exposes generic helpers (`showNotice`,
// `requestUndoableAction`) that ride the same toast surface.

import type { Folder, PageSummary } from "@pikos/core";
import { createContext, type ReactNode, useContext, useRef, useState } from "react";

import type { ToastItem } from "@/shared/components/Toast";
import { useUI } from "@/shared/context/UIContext";
import { useWorkspace } from "@/shared/context/WorkspaceContext";

export interface UndoDeleteContextValue {
  /** Request a deferred delete — hides the page immediately, commits after the toast expires. */
  requestDeletePage: (page: Pick<PageSummary, "id" | "title">) => void;
  /** Request a deferred folder delete — hides folder + pages immediately, commits after toast expires. */
  requestDeleteFolder: (folder: Folder, pageCount: number) => void;
  /** Set of page IDs currently pending deletion — filter these from all views. */
  hiddenPageIds: Set<string>;
  /** Set of folder IDs currently pending deletion — filter these from all views. */
  hiddenFolderIds: Set<string>;
  /** Items to render in the global Toast surface. */
  toastItems: ToastItem[];
  /** Called by Toast when the visual timer expires — commits pending deletes. */
  handleToastDismiss: (id: string) => void;

  /** Generic undoable action — shows a toast, calls undo callback if user clicks Undo. */
  requestUndoableAction: (id: string, label: string, undoFn: () => void) => void;

  /** Non-reversible confirmation — shows a toast with no action button. */
  showNotice: (label: string, durationMs?: number) => void;

  // Backwards-compat alias
  /** @deprecated Use hiddenPageIds instead. */
  hiddenIds: Set<string>;
}

const NOTICE_PREFIX = "notice:";
const FOLDER_UNDO_PREFIX = "folder:";

const UndoDeleteContext = createContext<UndoDeleteContextValue | null>(null);

export function UndoDeleteProvider({ children }: { children: ReactNode }) {
  const { pages, restoreFolder, restorePage, softDeleteFolder, softDeletePage } = useWorkspace();
  const { activePageId, setActivePage } = useUI();

  const pendingDeleteIds = useRef<Set<string>>(new Set());
  const [hiddenPageIds, setHiddenPageIds] = useState<Set<string>>(new Set());
  const [hiddenFolderIds, setHiddenFolderIds] = useState<Set<string>>(new Set());
  const [toastItems, setToastItems] = useState<ToastItem[]>([]);
  // Generic undoable action callbacks, keyed by toast item ID
  const undoCallbacks = useRef<Map<string, () => void>>(new Map());

  // Track which folder IDs are pending so we know how to undo
  const pendingFolderIds = useRef<Set<string>>(new Set());

  function removeToast(id: string) {
    setToastItems((prev) => prev.filter((item) => item.id !== id));
  }

  function undoPage(id: string) {
    pendingDeleteIds.current.delete(id);
    setHiddenPageIds((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
    void restorePage(id);
    removeToast(id);
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

  function requestDeletePage(page: Pick<PageSummary, "id" | "title">) {
    if (pendingDeleteIds.current.has(page.id)) return;
    pendingDeleteIds.current.add(page.id);
    // Close the editor if we're about to hide the active page — otherwise the
    // editor keeps rendering a stale page that no longer exists in any list.
    if (activePageId === page.id) setActivePage(null);
    setHiddenPageIds((prev) => new Set([...prev, page.id]));
    const title = page.title || "Untitled";
    setToastItems((prev) => [
      ...prev,
      {
        action: { label: "Undo", onClick: () => undoPage(page.id) },
        id: page.id,
        label: `Deleted “${title}”`,
      },
    ]);
    // Soft-delete immediately — page disappears from all DB queries
    void softDeletePage(page.id);
  }

  function requestDeleteFolder(folder: Folder, pageCount: number) {
    const undoId = `${FOLDER_UNDO_PREFIX}${folder.id}`;
    if (pendingDeleteIds.current.has(undoId)) return;
    pendingDeleteIds.current.add(undoId);
    pendingFolderIds.current.add(folder.id);
    // Close the editor if the active page lives inside the folder we're about
    // to hide — the cascade soft-delete removes it from the pages list.
    const activePage = activePageId ? pages.find((p) => p.id === activePageId) : null;
    if (activePage && activePage.folderId === folder.id) setActivePage(null);
    setHiddenFolderIds((prev) => new Set([...prev, folder.id]));
    const suffix = pageCount > 0 ? ` (${pageCount} ${pageCount === 1 ? "page" : "pages"})` : "";
    setToastItems((prev) => [
      ...prev,
      {
        action: { label: "Undo", onClick: () => undoFolder(undoId) },
        duration: 16000,
        id: undoId,
        label: `Deleted “${folder.name}${suffix}”`,
      },
    ]);
    // Soft-delete folder + all its pages immediately
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
      setHiddenPageIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
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

  const value: UndoDeleteContextValue = {
    handleToastDismiss,
    hiddenFolderIds,
    hiddenIds: hiddenPageIds,
    hiddenPageIds,
    requestDeleteFolder,
    requestDeletePage,
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
