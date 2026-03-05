"use client";

// UIContext — owns navigation and UI state.
// No data fetching — subscribe to VaultContext for pages/folders.

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import type { Page } from "@pikos/core";

// ─── Types ────────────────────────────────────────────────────────────────────

/** 'today' | 'inbox' | folderId (UUID string) */
export type ActiveViewId = "today" | "inbox" | (string & NonNullable<unknown>);

export interface UIContextValue {
  activePage: Page | null;
  setActivePage(page: Page | null): void;
  activeViewId: ActiveViewId;
  setActiveViewId(id: ActiveViewId): void;
  rightPanel: "editor" | "calendar";
  setRightPanel(panel: "editor" | "calendar"): void;
  /** Both left panels hidden. Persisted to localStorage. */
  sidebarCollapsed: boolean;
  setSidebarCollapsed(v: boolean): void;
}

const UIContext = createContext<UIContextValue | null>(null);

const SIDEBAR_KEY = "pikos:sidebarCollapsed";

// ─── Provider ─────────────────────────────────────────────────────────────────

export function UIProvider({ children }: { children: ReactNode }) {
  const [activePage, setActivePage] = useState<Page | null>(null);
  const [activeViewId, setActiveViewId] = useState<ActiveViewId>("inbox");
  const [rightPanel, setRightPanel] = useState<"editor" | "calendar">("editor");
  const [sidebarCollapsed, setSidebarCollapsedState] = useState<boolean>(() => {
    try {
      return localStorage.getItem(SIDEBAR_KEY) === "true";
    } catch {
      return false;
    }
  });

  const setSidebarCollapsed = useCallback((v: boolean) => {
    setSidebarCollapsedState(v);
    try {
      localStorage.setItem(SIDEBAR_KEY, String(v));
    } catch {
      // localStorage unavailable (e.g. private browsing) — ignore
    }
  }, []);

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
    }),
    [activePage, activeViewId, rightPanel, sidebarCollapsed, setSidebarCollapsed]
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
