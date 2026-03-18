"use client";

// UIContext — owns navigation and UI state.
// No data fetching — subscribe to WorkspaceContext for pages/folders.

import { createContext, useContext, useState, type ReactNode } from "react";
import type { PageSummary } from "@pikos/core";
import { useLocalStorage } from "@/shared/hooks/useLocalStorage";
import type { SortMode } from "@/features/pages/utils/pageFilters";

// ─── Types ────────────────────────────────────────────────────────────────────

/** 'today' | 'inbox' | folderId (UUID string) */
export type ActiveViewId = "today" | "inbox" | (string & NonNullable<unknown>);

export interface UIContextValue {
  /** ID of the currently selected page. Derive the full Page via useActivePage(). */
  activePageId: string | null;
  /** Accepts Page, string ID, or null — all equivalent. */
  setActivePage: (page: PageSummary | string | null) => void;
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
  /** Settings overlay open state. */
  settingsOpen: boolean;
  setSettingsOpen: (open: boolean) => void;
  /** Which sort dropdown is open ('folder-sort' | 'page-sort' | null). Shared to ensure mutual exclusion. */
  openSortMenu: string | null;
  setOpenSortMenu: (id: string | null) => void;
}

const UIContext = createContext<UIContextValue | null>(null);

// ─── Provider ─────────────────────────────────────────────────────────────────

export function UIProvider({ children }: { children: ReactNode }) {
  const [activePageId, setActivePageId] = useState<string | null>(null);
  const [activeViewId, setActiveViewId] = useState<ActiveViewId>("inbox");
  const [rightPanel, setRightPanel] = useState<"editor" | "calendar">("editor");
  const [sidebarCollapsed, setSidebarCollapsed] = useLocalStorage("pikos:sidebarCollapsed", false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [openSortMenu, setOpenSortMenu] = useState<string | null>(null);
  const [sortModes, setSortModes] = useLocalStorage<Record<string, SortMode>>(
    "pikos:sortModes",
    {}
  );

  function setActivePage(page: PageSummary | string | null) {
    if (page === null) setActivePageId(null);
    else if (typeof page === "string") setActivePageId(page);
    else setActivePageId(page.id);
  }

  function getSortMode(viewId: string): SortMode {
    return sortModes[viewId] ?? "manual";
  }

  function setSortMode(viewId: string, mode: SortMode) {
    setSortModes((prev) => ({ ...prev, [viewId]: mode }));
  }

  const value: UIContextValue = {
    activePageId,
    setActivePage,
    activeViewId,
    setActiveViewId,
    rightPanel,
    setRightPanel,
    sidebarCollapsed,
    setSidebarCollapsed,
    getSortMode,
    setSortMode,
    settingsOpen,
    setSettingsOpen,
    openSortMenu,
    setOpenSortMenu,
  };

  return <UIContext.Provider value={value}>{children}</UIContext.Provider>;
}

// ─── Hook ─────────────────────────────────────────────────────────────────────
// eslint-disable-next-line react-refresh/only-export-components
export function useUI(): UIContextValue {
  const ctx = useContext(UIContext);
  if (!ctx) throw new Error("useUI must be used within <UIProvider>");
  return ctx;
}
