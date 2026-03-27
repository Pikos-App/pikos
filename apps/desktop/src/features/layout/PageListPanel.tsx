// PageListPanel — middle panel (page list for active view). Default 280px, resizable.

import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import {
  ArrowUpDown,
  CalendarDays,
  CaseSensitive,
  ChevronRight,
  Flag,
  GripVertical,
  Plus,
} from "lucide-react";
import { Fragment, useEffect, useRef, useState } from "react";
import type React from "react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { PageListItem } from "@/features/pages/components/PageListItem";
import { usePageList } from "@/features/pages/hooks/usePageList";
import type { SortMode } from "@/features/pages/utils/pageFilters";
import { groupTodayPages } from "@/features/pages/utils/pageFilters";
import { cn } from "@/lib/utils";
import { IconToolbar } from "@/shared/components/IconToolbar";
import { InsertionLine } from "@/shared/components/InsertionLine";
import { TooltipIconButton } from "@/shared/components/TooltipIconButton";
import { useUI } from "@/shared/context/UIContext";
import { useInsertionLine } from "@/shared/hooks/useInsertionLine";
import { useLocalStorage } from "@/shared/hooks/useLocalStorage";
import { useMinuteTick } from "@/shared/hooks/useMinuteTick";
import { useKeyboardShortcut } from "@/shared/keyboard/useKeyboard";

interface PageListPanelProps {
  width: number;
  onResizeStart: (e: React.MouseEvent) => void;
}

export function PageListPanel({ onResizeStart, width }: PageListPanelProps) {
  const {
    activePage,
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
    renamingId,
    setRenamingId,
    visiblePages,
  } = usePageList();
  const {
    activeViewId,
    getSortMode,
    isDraggingOverCalendar,
    openSortMenu,
    setOpenDialog,
    setOpenSortMenu,
    setSidebarCollapsed,
    setSortMode,
    sidebarCollapsed,
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
    setCompletedCollapseState({ collapsed: !completedCollapsed, viewId: activeViewId });
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

  // Scroll active page into view when it changes via keyboard navigation.
  useEffect(() => {
    if (!activePage?.id || !listRef.current) return;
    const el = listRef.current.querySelector(`[data-page-id="${activePage.id}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [activePage?.id]);

  function navigatePage(direction: 1 | -1) {
    if (!visiblePages.length) return;
    if (sidebarCollapsed) setSidebarCollapsed(false);
    listRef.current?.setAttribute("data-keyboard-nav", "1");
    const currentIdx = activePage ? visiblePages.findIndex((p) => p.id === activePage.id) : -1;
    const newIdx =
      currentIdx === -1
        ? direction === 1
          ? 0
          : visiblePages.length - 1
        : Math.max(0, Math.min(visiblePages.length - 1, currentIdx + direction));
    const page = visiblePages[newIdx];
    if (page) handleSelectPage(page);
  }

  useKeyboardShortcut(
    "Mod+Shift+D",
    () => {
      if (activePage) {
        handleDeleteRequest(activePage);
      }
    },
    { allowInInputs: true }
  );

  useKeyboardShortcut("c", () => {
    if (activePage) handleToggleStatus(activePage.id, activePage.status);
  });

  // ── View grouping ──────────────────────────────────────────────────────────

  const isTodayView = activeViewId === "today";
  // Re-renders once per minute so overdue/today grouping stays current as time passes.
  useMinuteTick();
  const { overdue, today } = isTodayView
    ? groupTodayPages(visiblePages)
    : { overdue: [], today: [] };

  function renderPageItem(page: (typeof visiblePages)[0]) {
    return (
      <PageListItem
        folders={folders}
        isActive={activePage?.id === page.id}
        isRenaming={renamingId === page.id}
        key={page.id}
        onDelete={() => handleDeleteRequest(page)}
        onMoveToFolder={(folderId) => handleMoveToFolder(page.id, folderId)}
        onPriorityChange={(priority) => handlePriorityChange(page.id, priority)}
        onRenameCancel={handleRenameCancel}
        onRenameChange={(title) => handleRenameChange(page.id, title)}
        onRenameCommit={(title) => handleRenameCommit(page.id, title)}
        onRenameStart={() => setRenamingId(page.id)}
        onSelect={() => handleSelectPage(page)}
        onToggleDateFormat={toggleDateFormat}
        onToggleStatus={() => handleToggleStatus(page.id, page.status)}
        page={page}
        showRelative={showRelative}
      />
    );
  }

  return (
    <div
      className="relative flex h-full shrink-0 flex-col border-r border-border bg-background"
      style={{ width }}
    >
      {/* Header */}
      <div className="flex h-12 shrink-0 items-center justify-between border-b border-border px-3">
        <span className="text-sm font-semibold text-foreground">
          {activeViewId === "today" ? "Today" : activeViewId === "inbox" ? "Inbox" : "Pages"}
        </span>
        <IconToolbar aria-label="Page actions" className="flex items-center gap-0.5">
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
                      className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
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
            className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
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
          activeViewId === "today" ? "Today" : activeViewId === "inbox" ? "Inbox" : "Pages"
        }
        className="flex flex-col overflow-y-auto focus-visible:outline-none"
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            navigatePage(1);
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            navigatePage(-1);
          }
        }}
        onPointerMove={(e) => e.currentTarget.removeAttribute("data-keyboard-nav")}
        ref={listRef}
        role="group"
        tabIndex={0}
      >
        {visiblePages.length === 0 && completedPages.length === 0 ? (
          <p className="px-2 py-4 text-center text-xs text-muted-foreground italic">
            {activeViewId === "today" ? "Nothing scheduled for today" : "No pages"}
          </p>
        ) : isTodayView ? (
          // Today view: Overdue (collapsible) + Today sections.
          // SortableContext with a no-op strategy enables drag-to-calendar and
          // drag-to-folder without showing any list-reorder visual feedback.
          <SortableContext items={pageIds} strategy={() => null}>
            {overdue.length > 0 && (
              <>
                <button
                  className="flex w-full items-center gap-1.5 border-b border-border px-3 py-1.5 text-left text-xs font-medium text-muted-foreground hover:bg-accent/30"
                  onClick={toggleOverdue}
                >
                  <ChevronRight
                    className={cn("transition-transform", !overdueCollapsed && "rotate-90")}
                    size={12}
                  />
                  Overdue
                  <span className="ml-1 tabular-nums">· {overdue.length}</span>
                </button>
                {!overdueCollapsed && overdue.map(renderPageItem)}
              </>
            )}
            {today.length > 0 && (
              <>
                {overdue.length > 0 && (
                  <div className="border-b border-border px-3 py-1.5 text-xs font-medium text-muted-foreground">
                    Today
                    <span className="ml-1 tabular-nums">· {today.length}</span>
                  </div>
                )}
                {today.map(renderPageItem)}
              </>
            )}
            {completedPages.length > 0 && (
              <>
                <button
                  className="flex w-full items-center gap-1.5 border-t border-border px-3 py-1.5 text-left text-xs font-medium text-muted-foreground hover:bg-accent/30"
                  onClick={toggleCompletedCollapsed}
                >
                  <ChevronRight
                    className={cn("transition-transform", !completedCollapsed && "rotate-90")}
                    size={12}
                  />
                  Completed
                  <span className="ml-1 tabular-nums">· {completedPages.length}</span>
                </button>
                {!completedCollapsed && completedPages.map(renderPageItem)}
              </>
            )}
          </SortableContext>
        ) : (
          // Folder / Inbox views: sortable list with DnD + completed accordion
          <>
            <SortableContext items={pageIds} strategy={verticalListSortingStrategy}>
              {visiblePages.map((page) => (
                <Fragment key={page.id}>
                  {insertBeforeId === page.id && <InsertionLine />}
                  {renderPageItem(page)}
                </Fragment>
              ))}
              {insertBeforeId === null && <InsertionLine />}
            </SortableContext>
            {completedPages.length > 0 && (
              <>
                <button
                  className="flex w-full items-center gap-1.5 border-t border-border px-3 py-1.5 text-left text-xs font-medium text-muted-foreground hover:bg-accent/30"
                  onClick={toggleCompletedCollapsed}
                >
                  <ChevronRight
                    className={cn("transition-transform", !completedCollapsed && "rotate-90")}
                    size={12}
                  />
                  Completed
                  <span className="ml-1 tabular-nums">· {completedPages.length}</span>
                </button>
                {!completedCollapsed && completedPages.map(renderPageItem)}
              </>
            )}
          </>
        )}
      </div>

      {/* Drag handle — right edge */}
      <div
        className="absolute top-0 right-0 h-full w-1 cursor-col-resize transition-colors hover:bg-border/40 active:bg-border/60"
        onMouseDown={onResizeStart}
      />
    </div>
  );
}
