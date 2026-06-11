// UIContext — owns navigation and shell UI state.
// No data fetching — subscribe to WorkspaceContext for pages/folders.
// Multi-select state lives in SelectionContext (useSelection).
// Calendar DnD bridge lives in CalendarDnDContext (useCalendarDnD).

import type { PageSummary } from "@pikos/core";
import { createContext, type ReactNode, useContext, useRef, useState } from "react";

import type { SortMode } from "@/features/pages";
import { useLocalStorage } from "@/shared/hooks/useLocalStorage";

/** 'today' | 'inbox' | folderId (UUID string) */
export type ActiveViewId = "today" | "inbox" | (string & NonNullable<unknown>);
export type DialogId = "quick-add" | "search" | null;
/** Settings overlay sections. Kept here so external triggers (menu / shortcuts) can deep-link. */
export type SettingsSection = "general" | "notifications" | "data" | "shortcuts" | "developer";

export interface UIContextValue {
  /** ID of the currently selected page. Derive the full Page via useActivePage(). */
  activePageId: string | null;
  setActivePage: (page: PageSummary | string | null) => void;
  activeViewId: ActiveViewId;
  setActiveViewId: (id: ActiveViewId) => void;
  rightPanel: "editor" | "calendar";
  setRightPanel: (panel: "editor" | "calendar") => void;
  /** Page that was active before switching to calendar. Restored on Cmd+Shift+C back to editor. */
  lastEditorPageId: string | null;
  setLastEditorPageId: (id: string | null) => void;
  /** Currently viewed week reference date. Persisted so panel toggles don't reset the week. */
  referenceDate: Date;
  setReferenceDate: (d: Date) => void;
  /** Page ID to briefly flash after navigation (e.g. "View in calendar" jump). Cleared automatically. */
  highlightedPageId: string | null;
  /** Trigger a one-shot highlight animation on the page's calendar block. */
  flashPageBlock: (pageId: string) => void;
  /**
   * One-shot scroll target for the calendar timed grid. Set by "view in calendar"
   * so WeekGrid can scroll to the page's hour after the panel reveals. Token
   * increments per request so the consumer can apply each request exactly once
   * even when re-targeting the same hour.
   */
  calendarScrollRequest: { hour: number; token: number } | null;
  /** Request a calendar scroll to a specific hour (0–24). Token assigned internally. */
  requestCalendarScroll: (hour: number) => void;
  /** Both left panels hidden. Persisted to localStorage. */
  sidebarCollapsed: boolean;
  setSidebarCollapsed: (v: boolean | ((prev: boolean) => boolean)) => void;
  /** Page list overlay drawer open state. Only meaningful at the sm breakpoint. Not persisted. */
  pageListDrawerOpen: boolean;
  setPageListDrawerOpen: (v: boolean) => void;
  /** Per-view sort mode. Persisted to localStorage. */
  getSortMode: (viewId: string) => SortMode;
  setSortMode: (viewId: string, mode: SortMode) => void;
  settingsOpen: boolean;
  setSettingsOpen: (open: boolean) => void;
  /** Active section inside the settings overlay. Persists across open/close. */
  settingsSection: SettingsSection;
  setSettingsSection: (section: SettingsSection) => void;
  /** Which sort dropdown is open ('folder-sort' | 'page-sort' | null). Shared to ensure mutual exclusion. */
  openSortMenu: string | null;
  setOpenSortMenu: (id: string | null) => void;
  /** Which dialog is open app-wide ('quick-add' | null). */
  openDialog: string | null;
  /**
   * Open or close a dialog. `prefill` is consumed once by the dialog on open
   * (currently the input field for quick-add / search). Cleared automatically
   * when the dialog closes.
   */
  setOpenDialog: (id: DialogId | null, prefill?: string) => void;
  /** Initial text the next-opened dialog should populate its input with. */
  dialogPrefill: string | null;
  /**
   * Open a page in the editor. Switches to editor panel and sets activePageId
   * atomically — bypasses setRightPanel's restore logic so order never matters.
   */
  openPage: (page: PageSummary | string) => void;
}

const UIContext = createContext<UIContextValue | null>(null);

export function UIProvider({ children }: { children: ReactNode }) {
  const [activePageId, setActivePageId] = useLocalStorage<string | null>(
    "pikos:lastActivePageId",
    null
  );
  const [activeViewId, setActiveViewId] = useLocalStorage<ActiveViewId>(
    "pikos:lastActiveViewId",
    "inbox"
  );
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
  const [pageListDrawerOpen, setPageListDrawerOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState<SettingsSection>("general");
  const [openSortMenu, setOpenSortMenu] = useState<string | null>(null);
  const [openDialog, setOpenDialogRaw] = useState<string | null>(null);
  const [dialogPrefill, setDialogPrefill] = useState<string | null>(null);
  function setOpenDialog(id: DialogId | null, prefill?: string) {
    setOpenDialogRaw(id);
    setDialogPrefill(id === null ? null : (prefill ?? null));
    // Dismiss Settings when opening a global dialog so closing the dialog
    // returns the user to the workspace, not back into Settings.
    if (id !== null) setSettingsOpen(false);
  }
  const [sortModes, setSortModes] = useLocalStorage<Record<string, SortMode>>(
    "pikos:sortModes",
    {}
  );

  const [highlightedPageId, setHighlightedPageId] = useState<string | null>(null);
  const highlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  function flashPageBlock(pageId: string) {
    if (highlightTimerRef.current !== null) clearTimeout(highlightTimerRef.current);
    setHighlightedPageId(pageId);
    highlightTimerRef.current = setTimeout(() => {
      setHighlightedPageId(null);
      highlightTimerRef.current = null;
    }, 1600);
  }

  const [calendarScrollRequest, setCalendarScrollRequest] = useState<{
    hour: number;
    token: number;
  } | null>(null);
  const calendarScrollTokenRef = useRef(0);
  function requestCalendarScroll(hour: number) {
    calendarScrollTokenRef.current += 1;
    setCalendarScrollRequest({ hour, token: calendarScrollTokenRef.current });
  }

  const referenceDate = new Date(referenceDateIso);

  function setReferenceDate(d: Date) {
    setReferenceDateIso(d.toISOString());
  }

  function setActivePage(page: PageSummary | string | null) {
    if (page === null) setActivePageId(null);
    else if (typeof page === "string") setActivePageId(page);
    else setActivePageId(page.id);
    setPageListDrawerOpen(false);
  }

  function setRightPanel(panel: "editor" | "calendar") {
    if (panel === "calendar" && rightPanel !== "calendar") {
      setLastEditorPageId(activePageId);
      setActivePageId(null);
    } else if (panel === "editor" && rightPanel !== "editor") {
      setActivePageId(lastEditorPageId);
    }
    setRightPanelRaw(panel);
  }

  function openPage(page: PageSummary | string) {
    const id = typeof page === "string" ? page : page.id;
    setActivePageId(id);
    setRightPanelRaw("editor");
    setPageListDrawerOpen(false);
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
    calendarScrollRequest,
    dialogPrefill,
    flashPageBlock,
    getSortMode,
    highlightedPageId,
    lastEditorPageId,
    openDialog,
    openPage,
    openSortMenu,
    pageListDrawerOpen,
    referenceDate,
    requestCalendarScroll,
    rightPanel,
    setActivePage,
    setActiveViewId,
    setLastEditorPageId,
    setOpenDialog,
    setOpenSortMenu,
    setPageListDrawerOpen,
    setReferenceDate,
    setRightPanel,
    setSettingsOpen,
    setSettingsSection,
    setSidebarCollapsed,
    setSortMode,
    settingsOpen,
    settingsSection,
    sidebarCollapsed,
  };

  return <UIContext.Provider value={value}>{children}</UIContext.Provider>;
}

// eslint-disable-next-line react-refresh/only-export-components
export function useUI(): UIContextValue {
  const ctx = useContext(UIContext);
  if (!ctx) throw new Error("useUI must be used within <UIProvider>");
  return ctx;
}
