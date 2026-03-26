"use client";

// UndoDeleteContext — app-wide deferred page deletion with undo.
// Pages are hidden from the UI immediately; the real DB delete fires when the
// UndoToast timer expires (onDismiss). Undo cancels the pending delete.
// Callers are responsible for deselecting the active page before calling requestDeletePage.

import type { PageSummary } from "@pikos/core";
import { createContext, type ReactNode, useContext, useRef, useState } from "react";

import type { UndoToastItem } from "@/shared/components/UndoToast";
import { useWorkspace } from "@/shared/context/WorkspaceContext";

export interface UndoDeleteContextValue {
  /** Request a deferred delete — hides the page immediately, commits after the toast expires. */
  requestDeletePage: (page: Pick<PageSummary, "id" | "title">) => void;
  /** Set of page IDs currently pending deletion — filter these from all views. */
  hiddenIds: Set<string>;
  /** Items to render in the UndoToast. */
  undoItems: UndoToastItem[];
  /** Called by UndoToast when the visual timer expires — commits the real DB delete. */
  handleUndoDismiss: (id: string) => void;
  /** Called by UndoToast when the user clicks Undo — restores the page. */
  handleUndoDelete: (id: string) => void;
}

const UndoDeleteContext = createContext<UndoDeleteContextValue | null>(null);

export function UndoDeleteProvider({ children }: { children: ReactNode }) {
  const { deletePage } = useWorkspace();

  const pendingDeleteIds = useRef<Set<string>>(new Set());
  const [hiddenIds, setHiddenIds] = useState<Set<string>>(new Set());
  const [undoItems, setUndoItems] = useState<UndoToastItem[]>([]);

  function requestDeletePage(page: Pick<PageSummary, "id" | "title">) {
    if (pendingDeleteIds.current.has(page.id)) return;
    pendingDeleteIds.current.add(page.id);
    setHiddenIds((prev) => new Set([...prev, page.id]));
    setUndoItems((prev) => [...prev, { id: page.id, label: page.title }]);
  }

  function handleUndoDismiss(id: string) {
    pendingDeleteIds.current.delete(id);
    setHiddenIds((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
    setUndoItems((prev) => prev.filter((item) => item.id !== id));
    void deletePage(id);
  }

  function handleUndoDelete(id: string) {
    pendingDeleteIds.current.delete(id);
    setHiddenIds((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
    setUndoItems((prev) => prev.filter((item) => item.id !== id));
  }

  const value: UndoDeleteContextValue = {
    handleUndoDelete,
    handleUndoDismiss,
    hiddenIds,
    requestDeletePage,
    undoItems,
  };

  return <UndoDeleteContext.Provider value={value}>{children}</UndoDeleteContext.Provider>;
}

// eslint-disable-next-line react-refresh/only-export-components
export function useUndoDelete(): UndoDeleteContextValue {
  const ctx = useContext(UndoDeleteContext);
  if (!ctx) throw new Error("useUndoDelete must be used within <UndoDeleteProvider>");
  return ctx;
}
