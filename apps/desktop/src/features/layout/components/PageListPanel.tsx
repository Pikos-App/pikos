import { SortableContext } from "@dnd-kit/sortable";
import type { PageSummary } from "@pikos/core";
import { nowLocalISO } from "@pikos/core";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ChevronRight } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type React from "react";

import { shouldHideSidebar, useLayoutMode } from "@/features/layout/breakpoints";
import { groupTodayPages, PageListItem, usePageList } from "@/features/pages";
import { partitionToggleSelection } from "@/features/pages/utils/toggleSelection";
import { cn } from "@/lib/utils";
import { InsertionLine } from "@/shared/components/InsertionLine";
import { useCalendarDnD } from "@/shared/context/CalendarDnDContext";
import { useListSettings } from "@/shared/context/ListSettingsContext";
import { usePages } from "@/shared/context/PagesContext";
import { useSelection } from "@/shared/context/SelectionContext";
import { useUI } from "@/shared/context/UIContext";
import { useInsertionLine } from "@/shared/hooks/useInsertionLine";
import { useLocalStorage } from "@/shared/hooks/useLocalStorage";
import { useMinuteTick } from "@/shared/hooks/useMinuteTick";
import { isArrowKeyConsumer, isInteractiveTarget } from "@/shared/keyboard/isInteractiveTarget";
import { useKeyboardShortcut } from "@/shared/keyboard/useKeyboard";

import { buildPageListRows } from "../utils/buildPageListRows";
import type { VirtualRow } from "../utils/buildPageListRows";
import { PageListEmptyState } from "./PageListEmptyState";
import { PageListHeader, viewName } from "./PageListHeader";

interface PageListPanelProps {
  width: number;
  onResizeStart: (e: React.MouseEvent) => void;
}

export function PageListPanel({ onResizeStart, width }: PageListPanelProps) {
  const {
    activePage,
    completedHasMore,
    completedPages,
    folders,
    handleDeleteRequest,
    handleMoveToFolder,
    handlePriorityChange,
    handleRenameCancel,
    handleRenameChange,
    handleRenameCommit,
    handleSelectPage,
    handleToggleStatus,
    loadMoreCompleted,
    onExpandCompleted,
    renamingId,
    setRenamingId,
    visiblePages,
  } = usePageList();
  const { clearSchedule, completeRecurringPage, recurrenceRules, setPagesStatus } = usePages();
  const {
    activeViewId,
    getSortMode,
    openDialog,
    openSortMenu,
    setOpenDialog,
    setOpenSortMenu,
    setSidebarCollapsed,
    setSortMode,
    settingsOpen,
    sidebarCollapsed,
  } = useUI();
  const {
    clearSelection,
    selectAll,
    selectedPageIds,
    setRangeSelection,
    setSelectionAnchorId,
    togglePageSelection,
  } = useSelection();
  const { isDraggingOverCalendar } = useCalendarDnD();
  const sortMode = activeViewId !== "today" ? getSortMode(activeViewId) : "date";
  const sidebarHidden = shouldHideSidebar(useLayoutMode());
  const { density } = useListSettings();
  const [showRelative, setShowRelative] = useLocalStorage("pikos:showRelativeDates", false);
  const [overdueCollapsed, setOverdueCollapsed] = useLocalStorage("pikos:overdueCollapsed", true);
  // Completed accordion resets to collapsed on every view navigation (no persistence).
  // Storing { viewId, collapsed } means the value auto-resets whenever activeViewId changes.
  const [completedCollapseState, setCompletedCollapseState] = useState<{
    viewId: string;
    collapsed: boolean;
  }>({ collapsed: true, viewId: activeViewId });
  const completedCollapsed =
    completedCollapseState.viewId !== activeViewId ? true : completedCollapseState.collapsed;
  function toggleCompletedCollapsed() {
    const willExpand = completedCollapsed;
    setCompletedCollapseState({ collapsed: !completedCollapsed, viewId: activeViewId });
    if (willExpand) void onExpandCompleted();
  }

  function toggleDateFormat() {
    setShowRelative((v) => !v);
  }
  function toggleOverdue() {
    setOverdueCollapsed((v) => !v);
  }

  const pageIds = visiblePages.map((p) => p.id);
  const insertBeforeIdRaw = useInsertionLine(pageIds);
  // Hide the insertion line when dragging toward the calendar or when the list
  // is sorted automatically (reorder won't commit in non-manual modes).
  const insertBeforeId =
    isDraggingOverCalendar || sortMode !== "manual" ? undefined : insertBeforeIdRaw;

  const listRef = useRef<HTMLDivElement>(null);
  const navRafRef = useRef<number | null>(null);

  const isTodayView = activeViewId === "today";
  // Re-renders once per minute so overdue/today grouping stays current as time passes.
  useMinuteTick();
  const { overdue, today } = isTodayView
    ? groupTodayPages(visiblePages)
    : { overdue: [], today: [] };

  const { pageToRowIndex, rows } = buildPageListRows({
    completedCollapsed,
    completedHasMore,
    completedPages,
    isTodayView,
    overdue,
    overdueCollapsed,
    today,
    visiblePages,
  });

  // eslint-disable-next-line react-hooks/incompatible-library -- TanStack Virtual + React Compiler known issue
  const virtualizer = useVirtualizer({
    count: rows.length,
    estimateSize: (index) => {
      const row = rows[index];
      if (!row) return 52;
      switch (row.type) {
        case "section-header":
        case "completed-toggle":
        case "load-more":
          return 33;
        case "empty-state":
          return 200;
        case "empty-completed":
          return 40;
        case "page": {
          // Compact hides subtitle; cozy matches current; spacious adds ~8px.
          if (density === "compact") return 44;
          const base = row.page.subtitle ? 68 : 52;
          return density === "spacious" ? base + 8 : base;
        }
      }
    },
    getItemKey: (index) => rows[index]?.key ?? String(index),
    getScrollElement: () => listRef.current,
    overscan: 15,
  });

  // Scroll active page into view when it changes via keyboard navigation.
  useEffect(() => {
    if (!activePage?.id) return;
    const rowIndex = pageToRowIndex.get(activePage.id);
    if (rowIndex !== undefined) {
      virtualizer.scrollToIndex(rowIndex, { align: "auto" });
    }
  }, [activePage?.id]);

  function navigatePage(direction: 1 | -1) {
    // Walk pages in rendered order — `rows` already encodes Today's
    // overdue→today grouping, per-view sort, and which sections are expanded.
    // Using `visiblePages` here would diverge from the screen on Today (no sort
    // applied in usePageList — grouping does the ordering) and would also miss
    // the overdueCollapsed / completedCollapsed gates.
    const navigable = rows.flatMap((r) => (r.type === "page" ? [r.page] : []));
    if (!navigable.length) return;
    if (sidebarCollapsed) setSidebarCollapsed(false);
    listRef.current?.setAttribute("data-keyboard-nav", "1");
    const currentIdx = activePage ? navigable.findIndex((p) => p.id === activePage.id) : -1;
    if (currentIdx === -1) {
      // Active page not in navigable list (e.g. it's inside a collapsed section).
      // Up → last visible page; down → do nothing (avoid jumping to top).
      if (direction === -1) {
        const page = navigable[navigable.length - 1];
        if (page) handleSelectPage(page);
      }
      return;
    }
    const newIdx = Math.max(0, Math.min(navigable.length - 1, currentIdx + direction));
    const page = navigable[newIdx];
    if (page) handleSelectPage(page);
  }

  function deleteSelectedOrActive() {
    if (selectedPageIds.size > 0) {
      const allPages = [...visiblePages, ...completedPages];
      const selected = allPages.filter((p) => selectedPageIds.has(p.id));
      for (const page of selected) {
        handleDeleteRequest(page);
      }
      clearSelection();
    } else if (activePage) {
      handleDeleteRequest(activePage);
    }
  }

  useKeyboardShortcut("Mod+Backspace", deleteSelectedOrActive);
  // Alias that also fires inside text inputs and the Tiptap editor, so the
  // user can delete the active page from the title/subtitle inputs or while
  // writing content. Gated to avoid surprise-deletes when a modal dialog
  // (Quick Add, Search, Settings) is on top — those put the user in a
  // different mental context where the activePage isn't what's being acted on.
  useKeyboardShortcut("Mod+Shift+Backspace", deleteSelectedOrActive, {
    allowInInputs: true,
    preventDefault: true,
    when: () => openDialog === null && !settingsOpen,
  });

  useKeyboardShortcut("Escape", () => clearSelection(), {
    when: () => selectedPageIds.size > 0,
  });

  useKeyboardShortcut(
    "Mod+a",
    () => {
      selectAll(visiblePages.map((p) => p.id));
      // Pull focus onto the list (role="group", non-interactive) so the next
      // Space/arrow acts on the selection. Without this, focus stays on whatever
      // was clicked — e.g. a folder row, which is role="button" and would
      // swallow Space (its own Enter/Space re-selects the folder), so the bulk
      // toggle never fired.
      listRef.current?.focus();
    },
    { preventDefault: true }
  );

  // Space: toggle completion. Registered globally so it works after Cmd+A
  // regardless of which non-editable element holds focus (body, sidebar
  // button, etc.). The `when` gate keeps Space inert outside the page-list
  // context — no accidental toggles when the user is e.g. on the calendar.
  async function toggleSelected() {
    const allPages = [...visiblePages, ...completedPages];
    const selected = allPages.filter((p) => selectedPageIds.has(p.id));
    const { recurring, toComplete, toUncomplete } = partitionToggleSelection(selected, (id) =>
      recurrenceRules.some((r) => r.pageId === id)
    );
    clearSelection();
    // Plain flips collapse to ONE transactional write per status group (not N
    // round-trips). Awaited so nothing else in this handler writes concurrently.
    if (toComplete.length > 0) await setPagesStatus(toComplete, "done", nowLocalISO());
    if (toUncomplete.length > 0) await setPagesStatus(toUncomplete, "not_started", null);
    // Recurring completion clones + advances the head, so it can't be a plain
    // flip. Complete each one at a time — awaited, never concurrently — so the
    // writers don't race the WAL pool, and never through the gap dialog (its
    // single pending slot would drop all but the last of a bulk selection).
    // Bulk uses the default "advance" policy; un-completing is a plain flip.
    for (const p of recurring) {
      if (p.status === "done") await setPagesStatus([p.id], "not_started", null);
      else await completeRecurringPage(p.id, "advance");
    }
  }
  useKeyboardShortcut(
    "Space",
    () => {
      if (selectedPageIds.size > 0) {
        void toggleSelected();
      } else if (activePage) {
        handleToggleStatus(activePage.id, activePage.status);
        listRef.current?.focus();
      }
    },
    {
      preventDefault: true,
      when: () =>
        !renamingId &&
        !isInteractiveTarget(document.activeElement) &&
        (selectedPageIds.size > 0 || activePage !== null),
    }
  );

  // Arrow Up/Down: move to the previous/next page. Registered globally (like
  // Space above) so navigation works regardless of which non-editable element
  // holds focus — e.g. after opening a page moves focus into the editor panel.
  // `allowInInputs` stays false, so arrows still move the cursor inside the
  // editor and text inputs.
  //
  // Stand down only when focus is on a control that natively consumes arrows
  // (popover trigger, listbox, etc.) so it owns the key press.
  function canNavigatePages() {
    if (renamingId || activePage === null) return false;
    return !isArrowKeyConsumer(document.activeElement);
  }
  // Discrete presses navigate immediately. Held-key auto-repeats (e.repeat) are
  // coalesced to one navigation per animation frame to avoid render saturation.
  function navigateFromKey(e: KeyboardEvent, direction: 1 | -1) {
    if (!e.repeat) {
      navigatePage(direction);
      return;
    }
    if (navRafRef.current != null) return;
    navRafRef.current = requestAnimationFrame(() => {
      navRafRef.current = null;
      navigatePage(direction);
    });
  }
  useKeyboardShortcut("ArrowUp", (e) => navigateFromKey(e, -1), {
    preventDefault: true,
    repeat: true,
    when: canNavigatePages,
  });
  useKeyboardShortcut("ArrowDown", (e) => navigateFromKey(e, 1), {
    preventDefault: true,
    repeat: true,
    when: canNavigatePages,
  });

  function handlePageClick(page: (typeof visiblePages)[0], e: React.MouseEvent) {
    const allIds = visiblePages.map((p) => p.id);
    if (e.shiftKey) {
      setRangeSelection(allIds, page.id, activePage?.id ?? undefined);
      return;
    }
    if (e.metaKey || e.ctrlKey) {
      togglePageSelection(page.id);
      return;
    }
    clearSelection();
    setSelectionAnchorId(page.id);
    handleSelectPage(page);
  }

  function getSelectedPages(triggerId: string) {
    if (!selectedPageIds.has(triggerId) || selectedPageIds.size <= 1) return null;
    const allPages = [...visiblePages, ...completedPages];
    const batch = allPages.filter((p) => selectedPageIds.has(p.id));
    return batch.length > 1 ? batch : null;
  }

  /** Run an action on all selected pages (if page is selected), or just the given page. */
  function batchAction(page: PageSummary, action: (p: PageSummary) => void) {
    const batch = getSelectedPages(page.id);
    if (batch) {
      for (const p of batch) action(p);
      clearSelection();
    } else {
      action(page);
    }
  }

  function renderPageItem(page: (typeof visiblePages)[0]) {
    return (
      <PageListItem
        folders={folders}
        isActive={activePage?.id === page.id}
        isRenaming={renamingId === page.id}
        isSelected={selectedPageIds.has(page.id)}
        key={page.id}
        onClearDate={() => batchAction(page, (p) => void clearSchedule(p.id))}
        onDelete={() => batchAction(page, (p) => handleDeleteRequest(p))}
        onMoveToFolder={(folderId) => batchAction(page, (p) => handleMoveToFolder(p.id, folderId))}
        onPriorityChange={(priority) => handlePriorityChange(page.id, priority)}
        onRenameCancel={handleRenameCancel}
        onRenameChange={(title) => handleRenameChange(page.id, title)}
        onRenameCommit={(title) => handleRenameCommit(page.id, title)}
        onRenameStart={() => setRenamingId(page.id)}
        onSelect={(e) => handlePageClick(page, e)}
        onToggleDateFormat={toggleDateFormat}
        onToggleStatus={() => {
          // A multi-select status toggle (clicking one selected row's checkbox)
          // routes through toggleSelected, which serializes its writes. The old
          // batchAction loop fired N concurrent writes and hit the same WAL race
          // as Cmd+A → Space (QA §4). Single rows flip directly.
          if (getSelectedPages(page.id)) void toggleSelected();
          else handleToggleStatus(page.id, page.status);
        }}
        page={page}
        showRelative={showRelative}
      />
    );
  }

  function renderVirtualRow(row: VirtualRow) {
    switch (row.type) {
      case "empty-state":
        return <PageListEmptyState activeViewId={activeViewId} />;

      case "section-header":
        return row.collapsible ? (
          <button
            className="type-ui-sm flex w-full items-center gap-1.5 border-b border-border px-3 py-1.5 text-left text-muted-foreground hover:bg-accent/50"
            onClick={row.key === "overdue-header" ? toggleOverdue : undefined}
          >
            <ChevronRight
              className={cn("transition-transform", !row.collapsed && "rotate-90")}
              size={12}
            />
            {row.label}
            <span className="ml-1 tabular-nums">· {row.count}</span>
          </button>
        ) : (
          <div className="type-ui-sm border-b border-border px-3 py-1.5 text-muted-foreground">
            {row.label}
            <span className="ml-1 tabular-nums">· {row.count}</span>
          </div>
        );

      case "page": {
        // Only show insertion line for active pages (not completed).
        const showLine =
          !isTodayView && insertBeforeId === row.page.id && pageIds.includes(row.page.id);
        return (
          <div className="relative">
            {showLine && (
              <div className="absolute top-0 right-0 left-0 z-10 -translate-y-1/2">
                <InsertionLine />
              </div>
            )}
            {renderPageItem(row.page)}
          </div>
        );
      }

      case "completed-toggle":
        return (
          <div className="relative">
            {!isTodayView && insertBeforeId === null && (
              <div className="absolute top-0 right-0 left-0 z-10 -translate-y-1/2">
                <InsertionLine />
              </div>
            )}
            <button
              className="type-ui-sm flex w-full items-center gap-1.5 px-3 py-1.5 text-left text-muted-foreground hover:bg-accent/50"
              onClick={toggleCompletedCollapsed}
            >
              <ChevronRight
                className={cn("transition-transform", !completedCollapsed && "rotate-90")}
                size={12}
              />
              Completed
            </button>
          </div>
        );

      case "load-more":
        return (
          <button
            className="w-full px-3 py-1.5 text-left text-xs text-muted-foreground/50 transition-colors hover:text-muted-foreground/70"
            onClick={() => void loadMoreCompleted()}
          >
            Show more completed
          </button>
        );

      case "empty-completed":
        return <div className="type-ui-sm px-3 py-3 text-muted-foreground">No completed pages</div>;
    }
  }

  return (
    <div
      className="relative flex h-full shrink-0 flex-col border-r border-border-secondary bg-surface-secondary"
      style={{ width }}
    >
      <PageListHeader
        activeViewId={activeViewId}
        folders={folders}
        onOpenDialog={setOpenDialog}
        openSortMenu={openSortMenu}
        setOpenSortMenu={setOpenSortMenu}
        setSortMode={setSortMode}
        sidebarHidden={sidebarHidden}
        sortMode={sortMode}
      />

      {/* Page list */}
      {}
      <div
        aria-label={viewName(activeViewId, folders)}
        className="flex flex-col overflow-y-auto focus-visible:outline-none"
        onPointerMove={(e) => e.currentTarget.removeAttribute("data-keyboard-nav")}
        ref={listRef}
        role="group"
        tabIndex={0}
      >
        <SortableContext items={pageIds} strategy={() => null}>
          <div
            style={{
              height: virtualizer.getTotalSize(),
              position: "relative",
              width: "100%",
            }}
          >
            {virtualizer.getVirtualItems().map((virtualItem) => {
              const row = rows[virtualItem.index];
              if (!row) return null;
              return (
                <div
                  data-index={virtualItem.index}
                  key={virtualItem.key}
                  ref={virtualizer.measureElement}
                  style={{
                    left: 0,
                    position: "absolute",
                    top: 0,
                    transform: `translateY(${virtualItem.start}px)`,
                    width: "100%",
                  }}
                >
                  {renderVirtualRow(row)}
                </div>
              );
            })}
          </div>
        </SortableContext>
      </div>

      {/* Drag handle — right edge */}
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- pointer-only resize, kbd control deferred to the post-launch a11y backlog */}
      <div
        aria-label="Resize page list"
        aria-orientation="vertical"
        className="absolute top-0 right-0 h-full w-px cursor-col-resize border-r border-border-secondary transition-[width,background-color,border-color] duration-[var(--transition-fast)] hover:w-[3px] hover:border-r-0 hover:bg-border/40 data-[dragging]:w-[3px] data-[dragging]:border-r-0 data-[dragging]:bg-border/60"
        onMouseDown={onResizeStart}
        role="separator"
      />
    </div>
  );
}
