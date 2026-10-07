// UIContext — owns navigation and shell UI state.
// No data fetching — subscribe to WorkspaceContext for pages/folders.
// Multi-select state lives in SelectionContext (useSelection).
// Calendar DnD bridge lives in CalendarDnDContext (useCalendarDnD).

import type { PageSummary, SmartViewId, SortMode } from "@pikos/core";
import { isOpen, isSmartViewId } from "@pikos/core";
import { createContext, type ReactNode, useContext, useEffect, useRef, useState } from "react";

import { STORAGE_KEYS } from "@/shared/constants/storage";
import { usePages } from "@/shared/context/PagesContext";
import { useViewCacheController, useWorkspace } from "@/shared/context/WorkspaceContext";
import { useLocalStorage } from "@/shared/hooks/useLocalStorage";

import { CalendarDateProvider } from "./CalendarDateContext";

/** 'today' | 'upcoming' | 'inbox' | folderId (UUID string) */
export type ActiveViewId = SmartViewId | (string & NonNullable<unknown>);
export type DialogId = "quick-add" | "search" | null;
/** Settings overlay sections. Kept here so external triggers (menu / shortcuts) can deep-link. */
export type SettingsSection =
  | "general"
  | "notifications"
  | "calendar-sync"
  | "data"
  | "shortcuts"
  | "developer";

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
  /**
   * A focus session is hiding the left panels. Every consumer that hides them
   * must read this alongside `sidebarCollapsed` — the session hides the same
   * two panels, it just doesn't own the preference.
   *
   * Deliberately *not* persisted, and deliberately not written through
   * `sidebarCollapsed`: that flag is the user's standing choice, so a session
   * that set it would survive the session, the app quit, and the next launch —
   * panels gone with nothing left to explain why. Ending the session drops this
   * and the standing choice reappears on its own. An explicit toggle mid-session
   * clears it too, so the app stops fighting a decision the user just made.
   */
  focusZen: boolean;
  setFocusZen: (v: boolean) => void;
  /** Page list overlay drawer open state. Only meaningful at the sm breakpoint. Not persisted. */
  pageListDrawerOpen: boolean;
  setPageListDrawerOpen: (v: boolean) => void;
  /** Per-view sort mode. Persisted to localStorage. */
  getSortMode: (viewId: string, fallback?: SortMode) => SortMode;
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
   * `focusBody` puts the cursor at the end of the body once the page loads.
   */
  openPage: (page: PageSummary | string, options?: { focusBody?: boolean }) => void;
  /** Whether `pageId` was opened asking for the cursor in its body; true once, for the editor. */
  takeBodyFocus: (pageId: string) => boolean;
}

const UIContext = createContext<UIContextValue | null>(null);

export function UIProvider({ children }: { children: ReactNode }) {
  const { consumePendingNavigation, workspace } = useWorkspace();
  const { folders } = usePages();
  const viewCache = useViewCacheController();
  const [activePageId, setActivePageId] = useLocalStorage<string | null>(
    STORAGE_KEYS.lastActivePageId,
    null
  );
  const [activeViewId, setActiveViewId] = useLocalStorage<ActiveViewId>(
    STORAGE_KEYS.lastActiveViewId,
    "inbox"
  );
  const [rightPanel, setRightPanelRaw] = useLocalStorage<"editor" | "calendar">(
    STORAGE_KEYS.rightPanel,
    "editor"
  );
  const [lastEditorPageId, setLastEditorPageId] = useLocalStorage<string | null>(
    STORAGE_KEYS.lastEditorPageId,
    null
  );
  const [sidebarCollapsed, setSidebarCollapsed] = useLocalStorage(
    STORAGE_KEYS.sidebarCollapsed,
    false
  );
  const [focusZen, setFocusZen] = useState(false);
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
    STORAGE_KEYS.sortModes,
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

  // The database answers whether the pages the editor remembers are still open: at launch, and
  // after a change from outside, since another process can trash the page that's open here.
  const openIdsRef = useRef<(string | null)[]>([]);
  useEffect(() => {
    openIdsRef.current = [activePageId, lastEditorPageId];
  });
  useEffect(() => {
    if (!viewCache || !workspace) return;
    let cancelled = false;
    function closeIfGone(cache: NonNullable<typeof viewCache>) {
      const [active, last] = openIdsRef.current;
      const ids = [active, last].filter((id): id is string => id != null);
      if (ids.length === 0) return;
      void cache.currentRows(ids).then((found) => {
        if (cancelled) return;
        const open = new Set(found.filter(isOpen).map((p) => p.id));
        if (active != null && !open.has(active)) setActivePage(null);
        if (last != null && !open.has(last)) setLastEditorPageId(null);
      });
    }
    closeIfGone(viewCache);
    const unsubscribe = viewCache.onOutsideChange(() => closeIfGone(viewCache));
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [viewCache, workspace?.id]);

  // A ref, not state: the editor reads it once, as the page's content lands, and nothing renders it.
  const bodyFocusRef = useRef<string | null>(null);

  /** `openPage` without the focus request, so render can call it: render may not write a ref. */
  function showPage(id: string) {
    setActivePageId(id);
    setRightPanelRaw("editor");
    setPageListDrawerOpen(false);
  }

  function openPage(page: PageSummary | string, options?: { focusBody?: boolean }) {
    const id = typeof page === "string" ? page : page.id;
    bodyFocusRef.current = options?.focusBody ? id : null;
    showPage(id);
  }

  function takeBodyFocus(pageId: string): boolean {
    if (bodyFocusRef.current !== pageId) return false;
    bodyFocusRef.current = null;
    return true;
  }

  // The remembered view and page are checked against the workspace once it has
  // loaded, and a first launch's tutorial navigation applied. Done here, during
  // render, because this provider owns the state it corrects: from a child it was
  // an update to another component mid-render, which React rejects. Whether the
  // remembered pages still exist is the database's answer, in the effect above.
  const [checkedWorkspaceId, setCheckedWorkspaceId] = useState<string | null>(null);
  if (workspace && workspace.id !== checkedWorkspaceId) {
    // Stryker disable next-line CallExpression: checking again on every render reaches the same state
    setCheckedWorkspaceId(workspace.id);
    if (!isSmartViewId(activeViewId) && !folders.some((f) => f.id === activeViewId)) {
      setActiveViewId("inbox");
    }
    const nav = consumePendingNavigation();
    if (nav) {
      setActiveViewId(nav.folderId);
      showPage(nav.pageId);
    }
  }

  /** `fallback` lets a caller that knows what kind of view this is pick the
   *  starting order (see `useActiveSortMode`); a stored choice still wins. */
  function getSortMode(viewId: string, fallback: SortMode = "manual"): SortMode {
    return sortModes[viewId] ?? fallback;
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
    focusZen,
    getSortMode,
    highlightedPageId,
    lastEditorPageId,
    openDialog,
    openPage,
    openSortMenu,
    pageListDrawerOpen,
    requestCalendarScroll,
    rightPanel,
    setActivePage,
    setActiveViewId,
    setFocusZen,
    setLastEditorPageId,
    setOpenDialog,
    setOpenSortMenu,
    setPageListDrawerOpen,
    setRightPanel,
    setSettingsOpen,
    setSettingsSection,
    setSidebarCollapsed,
    setSortMode,
    settingsOpen,
    settingsSection,
    sidebarCollapsed,
    takeBodyFocus,
  };

  return (
    <UIContext.Provider value={value}>
      <CalendarDateProvider>{children}</CalendarDateProvider>
    </UIContext.Provider>
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export function useUI(): UIContextValue {
  const ctx = useContext(UIContext);
  if (!ctx) throw new Error("useUI must be used within <UIProvider>");
  return ctx;
}
