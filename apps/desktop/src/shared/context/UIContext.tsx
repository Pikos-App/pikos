"use client";

// UIContext — owns navigation and UI state.
// No data fetching — subscribe to WorkspaceContext for pages/folders.

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import type { Page } from "@pikos/core";
import { useLocalStorage } from "@/shared/hooks/useLocalStorage";
import type { SortMode } from "@/features/pages/utils/pageFilters";

// ─── Types ────────────────────────────────────────────────────────────────────

/** 'today' | 'inbox' | folderId (UUID string) */
export type ActiveViewId = "today" | "inbox" | (string & NonNullable<unknown>);

export interface UIContextValue {
  activePage: Page | null;
  setActivePage: (page: Page | null) => void;
  activeViewId: ActiveViewId;
  setActiveViewId: (id: ActiveViewId) => void;
  rightPanel: "editor" | "calendar";
  setRightPanel: (panel: "editor" | "calendar") => void;
  /** Both left panels hidden. Persisted to localStorage. */
  sidebarCollapsed: boolean;
  setSidebarCollapsed: (v: boolean | ((prev: boolean) => boolean)) => void;
  /** Per-view sort mode. Persisted to localStorage. */
  getSortMode: (viewId: string) => SortMode;
  setSortMode: (viewId: string, mode: SortMode) => void;
}

const UIContext = createContext<UIContextValue | null>(null);

// ─── Provider ─────────────────────────────────────────────────────────────────

export function UIProvider({ children }: { children: ReactNode }) {
  const [activePage, setActivePage] = useState<Page | null>(null);
  const [activeViewId, setActiveViewId] = useState<ActiveViewId>("inbox");
  const [rightPanel, setRightPanel] = useState<"editor" | "calendar">("editor");
  const [sidebarCollapsed, setSidebarCollapsed] = useLocalStorage("pikos:sidebarCollapsed", false);
  const [sortModes, setSortModes] = useLocalStorage<Record<string, SortMode>>(
    "pikos:sortModes",
    {}
  );

  const getSortMode = useCallback(
    (viewId: string): SortMode => sortModes[viewId] ?? "manual",
    [sortModes]
  );

  const setSortMode = useCallback(
    (viewId: string, mode: SortMode) => {
      setSortModes((prev) => ({ ...prev, [viewId]: mode }));
    },
    [setSortModes]
  );

  const value = useMemo<UIContextValue>(
    () => ({
      activePage,
      setActivePage,
      activeViewId,
      setActiveViewId,
      rightPanel,
      setRightPanel,
      sidebarCollapsed,
      setSidebarCollapsed,
      getSortMode,
      setSortMode,
    }),
    [
      activePage,
      activeViewId,
      rightPanel,
      sidebarCollapsed,
      setSidebarCollapsed,
      getSortMode,
      setSortMode,
    ]
  );

  return <UIContext.Provider value={value}>{children}</UIContext.Provider>;
}

// ─── Hook ─────────────────────────────────────────────────────────────────────
// eslint-disable-next-line react-refresh/only-export-components
export function useUI(): UIContextValue {
  const ctx = useContext(UIContext);
  if (!ctx) throw new Error("useUI must be used within <UIProvider>");
  return ctx;
}
