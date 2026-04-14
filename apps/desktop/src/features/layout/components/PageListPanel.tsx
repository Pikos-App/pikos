// PageListPanel — middle panel (page list for active view). Default 280px, resizable.

import { SortableContext } from "@dnd-kit/sortable";
import type { PageSummary } from "@pikos/core";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  ArrowUpDown,
  CalendarDays,
  CaseSensitive,
  ChevronRight,
  CircleCheck,
  FilePlus,
  Flag,
  GripVertical,
  Plus,
  Search,
  Sun,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type React from "react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { groupTodayPages, PageListItem, usePageList } from "@/features/pages";
import type { SortMode } from "@/features/pages";
import { cn } from "@/lib/utils";
import { EmptyState } from "@/shared/components/EmptyState";
import { IconToolbar } from "@/shared/components/IconToolbar";
import { InsertionLine } from "@/shared/components/InsertionLine";
import { TooltipIconButton } from "@/shared/components/TooltipIconButton";
import { useUI } from "@/shared/context/UIContext";
import { useWorkspace } from "@/shared/context/WorkspaceContext";
import { useInsertionLine } from "@/shared/hooks/useInsertionLine";
import { useLocalStorage } from "@/shared/hooks/useLocalStorage";
import { useMinuteTick } from "@/shared/hooks/useMinuteTick";
import { useKeyboardShortcut } from "@/shared/keyboard/useKeyboard";

import { buildPageListRows } from "../utils/buildPageListRows";
import type { VirtualRow } from "../utils/buildPageListRows";

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
  const { clearSchedule } = useWorkspace();
  const {
    activeViewId,
    clearSelection,
    getSortMode,
    isDraggingOverCalendar,
    openSortMenu,
    selectAll,
    selectedPageIds,
    setOpenDialog,
    setOpenSortMenu,
    setRangeSelection,
    setSelectionAnchorId,
    setSidebarCollapsed,
    setSortMode,
    sidebarCollapsed,
    togglePageSelection,
  } = useUI();
  const sortMode = activeViewId !== "today" ? getSortMode(activeViewId) : "date";
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

  // ── Keyboard navigation ────────────────────────────────────────────────────

  const listRef = useRef<HTMLDivElement>(null);
  const navRafRef = useRef<number | null>(null);

  // ── View grouping ──────────────────────────────────────────────────────────

  const isTodayView = activeViewId === "today";
  // Re-renders once per minute so overdue/today grouping stays current as time passes.
  useMinuteTick();
  const { overdue, today } = isTodayView
    ? groupTodayPages(visiblePages)
    : { overdue: [], today: [] };

  // ── Virtual row model ─────────────────────────────────────────────────────

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

  // ── Virtualizer ───────────────────────────────────────────────────────────

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
        case "page":
          return row.page.subtitle ? 68 : 52;
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
    const navigable = completedCollapsed ? visiblePages : [...visiblePages, ...completedPages];
    if (!navigable.length) return;
    if (sidebarCollapsed) setSidebarCollapsed(false);
    listRef.current?.setAttribute("data-keyboard-nav", "1");
    const currentIdx = activePage ? navigable.findIndex((p) => p.id === activePage.id) : -1;
    if (currentIdx === -1) {
      // Active page not in navigable list (e.g. completed section was collapsed).
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

  useKeyboardShortcut(
    "Mod+Shift+D",
    () => {
      if (selectedPageIds.size > 0) {
        // Bulk delete all selected pages
        const allPages = [...visiblePages, ...completedPages];
        const selected = allPages.filter((p) => selectedPageIds.has(p.id));
        for (const page of selected) {
          handleDeleteRequest(page);
        }
        clearSelection();
      } else if (activePage) {
        handleDeleteRequest(activePage);
      }
    },
    { allowInInputs: true }
  );

  // Escape: clear multi-selection
  useKeyboardShortcut("Escape", () => clearSelection(), {
    when: () => selectedPageIds.size > 0,
  });

  // Cmd+A: select all visible pages (not when focus is in an editor/input)
  useKeyboardShortcut(
    "Mod+a",
    () => {
      selectAll(visiblePages.map((p) => p.id));
    },
    { preventDefault: true }
  );

  function handlePageClick(page: (typeof visiblePages)[0], e: React.MouseEvent) {
    const allIds = visiblePages.map((p) => p.id);
    if (e.shiftKey) {
      // Shift+Click: range select from active page
      setRangeSelection(allIds, page.id, activePage?.id ?? undefined);
      return;
    }
    if (e.metaKey || e.ctrlKey) {
      // Cmd/Ctrl+Click: toggle individual selection
      togglePageSelection(page.id);
      return;
    }
    // Plain click: clear selection, set active
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
        onToggleStatus={() => batchAction(page, (p) => handleToggleStatus(p.id, p.status))}
        page={page}
        showRelative={showRelative}
      />
    );
  }

  function renderVirtualRow(row: VirtualRow) {
    switch (row.type) {
      case "empty-state":
        return activeViewId === "today" ? (
          <EmptyState icon={Sun} message="Nothing scheduled for today">
            <p className="type-ui-sm mt-1 text-subtle">
              Press <kbd className="rounded border border-border px-1 py-0.5 text-[10px]">⌘N</kbd>{" "}
              to create a page or drag one here
            </p>
          </EmptyState>
        ) : activeViewId === "inbox" ? (
          <EmptyState icon={CircleCheck} message="No pages in your inbox">
            <p className="type-ui-sm mt-1 text-subtle">
              Press <kbd className="rounded border border-border px-1 py-0.5 text-[10px]">⌘N</kbd>{" "}
              to create a new page
            </p>
          </EmptyState>
        ) : (
          <EmptyState icon={FilePlus} message="No pages in this folder">
            <p className="type-ui-sm mt-1 text-subtle">
              Press <kbd className="rounded border border-border px-1 py-0.5 text-[10px]">⌘N</kbd>{" "}
              to add a page
            </p>
          </EmptyState>
        );

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
              className="type-ui-sm flex w-full items-center gap-1.5 border-t border-border px-3 py-1.5 text-left text-muted-foreground hover:bg-accent/50"
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
      {/* Header */}
      <div className="flex h-12 shrink-0 items-center justify-between border-b border-border px-3">
        <span className="type-ui min-w-0 truncate text-foreground">
          {activeViewId === "today"
            ? "Today"
            : activeViewId === "inbox"
              ? "Inbox"
              : (folders.find((f) => f.id === activeViewId)?.name ?? "Pages")}
        </span>
        <IconToolbar aria-label="Page actions" className="flex items-center gap-0.5">
          <TooltipIconButton
            icon={<Search size={13} />}
            label="Search"
            onClick={() => setOpenDialog("search")}
            shortcut="mod+k"
            tabIndex={0}
          />
          {activeViewId !== "today" && (
            <DropdownMenu
              onOpenChange={(open) => setOpenSortMenu(open ? "page-sort" : null)}
              open={openSortMenu === "page-sort"}
            >
              <Tooltip>
                <TooltipTrigger asChild>
                  <DropdownMenuTrigger asChild>
                    <button
                      aria-label={`Sort: ${sortMode}`}
                      className="rounded p-1 text-text-tertiary transition-[background-color,color] duration-[var(--transition-fast)] hover:bg-surface-hover hover:text-text-secondary"
                      tabIndex={0}
                    >
                      <ArrowUpDown size={13} />
                    </button>
                  </DropdownMenuTrigger>
                </TooltipTrigger>
                <TooltipContent side="bottom">Sort: {sortMode}</TooltipContent>
              </Tooltip>
              <DropdownMenuContent align="end" className="w-40">
                {(
                  [
                    { icon: <CalendarDays size={13} />, label: "Date", value: "date" },
                    { icon: <CaseSensitive size={13} />, label: "Title", value: "title" },
                    { icon: <Flag size={13} />, label: "Priority", value: "priority" },
                    { icon: <GripVertical size={13} />, label: "Manual", value: "manual" },
                  ] as { value: SortMode; label: string; icon: React.ReactNode }[]
                ).map(({ icon, label, value }) => (
                  <DropdownMenuItem
                    className="gap-2"
                    key={value}
                    onSelect={() => setSortMode(activeViewId, value)}
                  >
                    {icon}
                    {label}
                    {sortMode === value && <span className="ml-auto text-primary">✓</span>}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          <TooltipIconButton
            icon={<Plus size={15} />}
            label="New Page"
            onClick={() => setOpenDialog("quick-add")}
            shortcut="mod+n"
            tabIndex={activeViewId === "today" ? 0 : -1}
          />
        </IconToolbar>
      </div>

      {/* Page list */}
      <div
        aria-label={
          activeViewId === "today"
            ? "Today"
            : activeViewId === "inbox"
              ? "Inbox"
              : (folders.find((f) => f.id === activeViewId)?.name ?? "Pages")
        }
        className="flex flex-col overflow-y-auto focus-visible:outline-none"
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            const dir = e.key === "ArrowDown" ? 1 : -1;
            // Coalesce held-key repeats into one navigation per animation
            // frame to prevent render saturation. Discrete presses (e.repeat
            // === false) always navigate immediately.
            if (e.repeat) {
              if (navRafRef.current != null) return;
              navRafRef.current = requestAnimationFrame(() => {
                navRafRef.current = null;
                navigatePage(dir);
              });
            } else {
              navigatePage(dir);
            }
          } else if (e.key === " " && !renamingId) {
            e.preventDefault();
            if (selectedPageIds.size > 0) {
              const allPages = [...visiblePages, ...completedPages];
              for (const p of allPages) {
                if (selectedPageIds.has(p.id)) {
                  handleToggleStatus(p.id, p.status);
                }
              }
              clearSelection();
            } else if (activePage) {
              handleToggleStatus(activePage.id, activePage.status);
              // Re-focus the list container — the active page's DOM node may
              // unmount (e.g. moved to completed) which drops focus to <body>.
              listRef.current?.focus();
            }
          }
        }}
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
      <div
        className="absolute top-0 right-0 h-full w-px cursor-col-resize border-r border-border-secondary transition-[width,background-color,border-color] duration-[var(--transition-fast)] hover:w-[3px] hover:border-r-0 hover:bg-border/40 data-[dragging]:w-[3px] data-[dragging]:border-r-0 data-[dragging]:bg-border/60"
        onMouseDown={onResizeStart}
      />
    </div>
  );
}
