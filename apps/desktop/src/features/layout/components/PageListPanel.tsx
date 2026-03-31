// PageListPanel — middle panel (page list for active view). Default 280px, resizable.

import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
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
import { Fragment, useEffect, useRef, useState } from "react";
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
          activeViewId === "today" ? (
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
          )
        ) : isTodayView ? (
          // Today view: Overdue (collapsible) + Today sections.
          // SortableContext with a no-op strategy enables drag-to-calendar and
          // drag-to-folder without showing any list-reorder visual feedback.
          <SortableContext items={pageIds} strategy={() => null}>
            {overdue.length > 0 && (
              <>
                <button
                  className="type-ui-sm flex w-full items-center gap-1.5 border-b border-border px-3 py-1.5 text-left text-muted-foreground hover:bg-accent/50"
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
                  <div className="type-ui-sm border-b border-border px-3 py-1.5 text-muted-foreground">
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
                  className="type-ui-sm flex w-full items-center gap-1.5 border-t border-border px-3 py-1.5 text-left text-muted-foreground hover:bg-accent/50"
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
                  className="type-ui-sm flex w-full items-center gap-1.5 border-t border-border px-3 py-1.5 text-left text-muted-foreground hover:bg-accent/50"
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
        className="absolute top-0 right-0 h-full w-px cursor-col-resize border-r border-border-secondary transition-[width,background-color,border-color] duration-[var(--transition-fast)] hover:w-[3px] hover:border-r-0 hover:bg-border/40 data-[dragging]:w-[3px] data-[dragging]:border-r-0 data-[dragging]:bg-border/60"
        onMouseDown={onResizeStart}
      />
    </div>
  );
}
