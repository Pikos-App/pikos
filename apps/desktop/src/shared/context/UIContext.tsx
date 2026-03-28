"use client";

// UIContext — owns navigation and UI state.
// No data fetching — subscribe to WorkspaceContext for pages/folders.

import type { PageSummary } from "@pikos/core";
import { createContext, type ReactNode, useContext, useRef, useState } from "react";

import type { SortMode } from "@/features/pages";
import { useLocalStorage } from "@/shared/hooks/useLocalStorage";

// ─── Types ────────────────────────────────────────────────────────────────────

/** 'today' | 'inbox' | folderId (UUID string) */
export type ActiveViewId = "today" | "inbox" | (string & NonNullable<unknown>);
export type DialogId = "quick-add" | "search" | null;

export interface UIContextValue {
  /** ID of the currently selected page. Derive the full Page via useActivePage(). */
  activePageId: string | null;
  /** Accepts Page, string ID, or null — all equivalent. */
  setActivePage: (page: PageSummary | string | null) => void;
  activeViewId: ActiveViewId;
  setActiveViewId: (id: ActiveViewId) => void;
  rightPanel: "editor" | "calendar";
  setRightPanel: (panel: "editor" | "calendar") => void;
  /** Page that was active before switching to calendar. Restored on Cmd+Shift+C back to editor. */
  lastEditorPageId: string | null;
  /** Currently viewed week reference date. Persisted so panel toggles don't reset the week. */
  referenceDate: Date;
  setReferenceDate: (d: Date) => void;
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
  /** Which dialog is open app-wide ('quick-add' | null). */
  openDialog: string | null;
  setOpenDialog: (id: DialogId | null) => void;
  /**
   * Open a page in the editor. Switches to editor panel and sets activePageId
   * atomically — bypasses setRightPanel's restore logic so order never matters.
   */
  openPage: (page: PageSummary | string) => void;
  /**
   * WeekGrid registers a function that, given cursor coordinates, computes the
   * calendar drop slot AND updates WeekGrid's own ghost preview state.
   * Returns { start } (ISO string for scheduleOnce) when cursor is over the calendar,
   * null otherwise. Call with any out-of-bounds coords to clear the preview.
   */
  /** True while a page-list item is being dragged over the calendar panel. */
  isDraggingOverCalendar: boolean;
  setIsDraggingOverCalendar: (v: boolean) => void;
  registerExternalDragUpdater: (
    fn:
      | ((
          clientX: number,
          clientY: number,
          folderColor: string | undefined,
          durationMs?: number,
          title?: string,
          isDone?: boolean
        ) => { start: string } | null)
      | null
  ) => void;
  callExternalDragUpdater: (
    clientX: number,
    clientY: number,
    folderColor: string | undefined,
    durationMs?: number,
    title?: string,
    isDone?: boolean
  ) => { start: string } | null;
}

const UIContext = createContext<UIContextValue | null>(null);

// ─── Provider ─────────────────────────────────────────────────────────────────

export function UIProvider({ children }: { children: ReactNode }) {
  const [activePageId, setActivePageId] = useState<string | null>(null);
  const [activeViewId, setActiveViewId] = useState<ActiveViewId>("inbox");
  const [rightPanel, setRightPanelRaw] = useLocalStorage<"editor" | "calendar">(
    "pikos:rightPanel",
    "editor"
  );
  const [lastEditorPageId, setLastEditorPageId] = useLocalStorage<string | null>(
    "pikos:lastEditorPageId",
    null
  );
  const [referenceDateIso, setReferenceDateIso] = useLocalStorage<string>(
    "pikos:calendarReferenceDate",
    new Date().toISOString()
  );
  const [sidebarCollapsed, setSidebarCollapsed] = useLocalStorage("pikos:sidebarCollapsed", false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [openSortMenu, setOpenSortMenu] = useState<string | null>(null);
  const [openDialog, setOpenDialog] = useState<string | null>(null);
  const [sortModes, setSortModes] = useLocalStorage<Record<string, SortMode>>(
    "pikos:sortModes",
    {}
  );

  const [isDraggingOverCalendar, setIsDraggingOverCalendar] = useState(false);

  const externalDragUpdaterRef = useRef<
    | ((
        clientX: number,
        clientY: number,
        folderColor: string | undefined,
        durationMs?: number,
        title?: string,
        isDone?: boolean
      ) => { start: string } | null)
    | null
  >(null);

  function registerExternalDragUpdater(
    fn:
      | ((
          clientX: number,
          clientY: number,
          folderColor: string | undefined,
          durationMs?: number,
          title?: string,
          isDone?: boolean
        ) => { start: string } | null)
      | null
  ) {
    externalDragUpdaterRef.current = fn;
  }

  function callExternalDragUpdater(
    clientX: number,
    clientY: number,
    folderColor: string | undefined,
    durationMs?: number,
    title?: string,
    isDone?: boolean
  ): { start: string } | null {
    return (
      externalDragUpdaterRef.current?.(clientX, clientY, folderColor, durationMs, title, isDone) ??
      null
    );
  }

  const referenceDate = new Date(referenceDateIso);

  function setReferenceDate(d: Date) {
    setReferenceDateIso(d.toISOString());
  }

  function setActivePage(page: PageSummary | string | null) {
    if (page === null) setActivePageId(null);
    else if (typeof page === "string") setActivePageId(page);
    else setActivePageId(page.id);
  }

  /** Smart panel switch — manages lastEditorPageId and activePageId transitions. */
  function setRightPanel(panel: "editor" | "calendar") {
    if (panel === "calendar" && rightPanel !== "calendar") {
      setLastEditorPageId(activePageId);
      setActivePageId(null);
    } else if (panel === "editor" && rightPanel !== "editor") {
      setActivePageId(lastEditorPageId);
    }
    setRightPanelRaw(panel);
  }

  /** Open a specific page in the editor — atomic, no ordering dependency. */
  function openPage(page: PageSummary | string) {
    const id = typeof page === "string" ? page : page.id;
    setActivePageId(id);
    setRightPanelRaw("editor");
  }

  function getSortMode(viewId: string): SortMode {
    return sortModes[viewId] ?? "manual";
  }

  function setSortMode(viewId: string, mode: SortMode) {
    setSortModes((prev) => ({ ...prev, [viewId]: mode }));
  }

  const value: UIContextValue = {
    activePageId,
    activeViewId,
    callExternalDragUpdater,
    getSortMode,
    isDraggingOverCalendar,
    lastEditorPageId,
    openDialog,
    openPage,
    openSortMenu,
    referenceDate,
    registerExternalDragUpdater,
    rightPanel,
    setActivePage,
    setActiveViewId,
    setIsDraggingOverCalendar,
    setOpenDialog,
    setOpenSortMenu,
    setReferenceDate,
    setRightPanel,
    setSettingsOpen,
    setSidebarCollapsed,
    setSortMode,
    settingsOpen,
    sidebarCollapsed,
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
