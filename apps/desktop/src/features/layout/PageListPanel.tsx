// PageListPanel — middle panel (page list for active view). Default 280px, resizable.

import { Fragment, useEffect, useRef, useState } from "react";
import { ArrowUpDown, Check, ChevronRight, Plus } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { SortMode } from "@/features/pages/utils/pageFilters";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { InsertionLine } from "@/shared/components/InsertionLine";
import { useInsertionLine } from "@/shared/hooks/useInsertionLine";
import { PageListItem } from "@/features/pages/components/PageListItem";
import { PageDeleteDialog } from "@/features/pages/components/PageDeleteDialog";
import { usePageList } from "@/features/pages/hooks/usePageList";
import { groupTodayPages } from "@/features/pages/utils/pageFilters";
import { useUI } from "@/shared/context/UIContext";
import { useLocalStorage } from "@/shared/hooks/useLocalStorage";
import { useMinuteTick } from "@/shared/hooks/useMinuteTick";
import { useKeyboardShortcut } from "@/shared/keyboard/useKeyboard";
import { cn } from "@/lib/utils";

interface PageListPanelProps {
  width: number;
  onResizeStart: (e: React.MouseEvent) => void;
}

export function PageListPanel({ width, onResizeStart }: PageListPanelProps) {
  const {
    visiblePages,
    completedTodayPages,
    folders,
    activePage,
    renamingId,
    setRenamingId,
    pendingDelete,
    handleCreatePage,
    handleRenameChange,
    handleRenameCommit,
    handleRenameCancel,
    handleDeleteRequest,
    handleDeleteConfirm,
    handleDeleteCancel,
    handleMoveToFolder,
    handleToggleStatus,
    handlePriorityChange,
    handleSelectPage,
  } = usePageList();
  const { activeViewId, sidebarCollapsed, setSidebarCollapsed, getSortMode, setSortMode } = useUI();
  const sortMode = activeViewId !== "today" ? getSortMode(activeViewId) : "date";
  const [sortOpen, setSortOpen] = useState(false);
  const [showRelative, setShowRelative] = useLocalStorage("pikos:showRelativeDates", false);
  const [overdueCollapsed, setOverdueCollapsed] = useLocalStorage("pikos:overdueCollapsed", true);
  const [completedCollapsed, setCompletedCollapsed] = useLocalStorage(
    "pikos:completedCollapsed",
    true
  );

  function toggleDateFormat() {
    setShowRelative((v) => !v);
  }
  function toggleOverdue() {
    setOverdueCollapsed((v) => !v);
  }

  const pageIds = visiblePages.map((p) => p.id);
  const insertBeforeId = useInsertionLine(pageIds);

  // ── Keyboard navigation ────────────────────────────────────────────────────

  // Store { viewId, pageId } so the highlight auto-clears when the view changes
  // without needing a setState-in-effect pattern.
  const [highlighted, setHighlighted] = useState<{ viewId: string; pageId: string } | null>(null);
  const highlightedPageId = highlighted?.viewId === activeViewId ? highlighted.pageId : null;
  const listRef = useRef<HTMLDivElement>(null);

  // Scroll highlighted item into view
  useEffect(() => {
    if (!highlightedPageId || !listRef.current) return;
    const el = listRef.current.querySelector(`[data-page-id="${highlightedPageId}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [highlightedPageId]);

  function moveHighlight(direction: 1 | -1) {
    if (sidebarCollapsed) setSidebarCollapsed(false);
    setHighlighted((prev) => {
      if (!visiblePages.length) return null;
      const prevId = prev?.viewId === activeViewId ? prev.pageId : null;
      const idx = prevId !== null ? visiblePages.findIndex((p) => p.id === prevId) : -1;
      let newIdx: number;
      if (idx === -1) {
        newIdx = direction === 1 ? 0 : visiblePages.length - 1;
      } else {
        newIdx = Math.max(0, Math.min(visiblePages.length - 1, idx + direction));
      }
      const pageId = visiblePages[newIdx]?.id;
      return pageId !== undefined ? { viewId: activeViewId, pageId } : null;
    });
  }

  function openHighlighted() {
    if (!highlightedPageId) return;
    if (sidebarCollapsed) setSidebarCollapsed(false);
    const page = visiblePages.find((p) => p.id === highlightedPageId);
    if (page) handleSelectPage(page);
  }

  useKeyboardShortcut("J", () => moveHighlight(1), { allowInInputs: false });
  useKeyboardShortcut("K", () => moveHighlight(-1), { allowInInputs: false });
  useKeyboardShortcut("Enter", openHighlighted, { allowInInputs: false });

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
        key={page.id}
        page={page}
        isActive={activePage?.id === page.id}
        isHighlighted={highlightedPageId === page.id}
        isRenaming={renamingId === page.id}
        folders={folders}
        onSelect={() => handleSelectPage(page)}
        onRenameStart={() => setRenamingId(page.id)}
        onRenameChange={(title) => handleRenameChange(page.id, title)}
        onRenameCommit={(title) => handleRenameCommit(page.id, title)}
        onRenameCancel={handleRenameCancel}
        onDelete={() => handleDeleteRequest(page)}
        dragDisabled={sortMode !== "manual"}
        onMoveToFolder={(folderId) => handleMoveToFolder(page.id, folderId)}
        onToggleStatus={() => handleToggleStatus(page.id, page.status)}
        onPriorityChange={(priority) => handlePriorityChange(page.id, priority)}
        showRelative={showRelative}
        onToggleDateFormat={toggleDateFormat}
      />
    );
  }

  return (
    <div
      className="relative flex h-full shrink-0 flex-col border-r border-border bg-background"
      style={{ width }}
    >
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border px-3 py-1.5">
        <span className="text-sm font-semibold text-foreground">
          {activeViewId === "today" ? "Today" : activeViewId === "inbox" ? "Inbox" : "Pages"}
        </span>
        <div className="flex items-center gap-0.5">
          {activeViewId !== "today" && (
            <Popover open={sortOpen} onOpenChange={setSortOpen}>
              <PopoverTrigger asChild>
                <button
                  className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
                  title={`Sort: ${sortMode}`}
                >
                  <ArrowUpDown size={13} />
                </button>
              </PopoverTrigger>
              <PopoverContent className="w-44 p-1" align="end">
                {(
                  [
                    { value: "date", label: "Date" },
                    { value: "title", label: "Title" },
                    { value: "priority", label: "Priority" },
                    { value: "manual", label: "Manual" },
                  ] as { value: SortMode; label: string }[]
                ).map(({ value, label }) => (
                  <button
                    key={value}
                    className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent"
                    onClick={() => {
                      setSortMode(activeViewId, value);
                      setSortOpen(false);
                    }}
                  >
                    <Check
                      size={13}
                      className={sortMode === value ? "text-foreground" : "invisible"}
                    />
                    {label}
                  </button>
                ))}
              </PopoverContent>
            </Popover>
          )}
          <button
            className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
            title="New Page"
            onClick={() => void handleCreatePage()}
          >
            <Plus size={15} />
          </button>
        </div>
      </div>

      {/* Page list */}
      <div ref={listRef} className="flex flex-col overflow-y-auto">
        {visiblePages.length === 0 && (!isTodayView || completedTodayPages.length === 0) ? (
          <p className="px-2 py-4 text-center text-xs text-muted-foreground italic">
            {activeViewId === "today" ? "Nothing scheduled for today" : "No pages"}
          </p>
        ) : isTodayView ? (
          // Today view: Overdue (collapsible) + Today sections
          <>
            {overdue.length > 0 && (
              <>
                <button
                  className="flex w-full items-center gap-1.5 border-b border-border px-3 py-1.5 text-left text-xs font-medium text-muted-foreground hover:bg-accent/30"
                  onClick={toggleOverdue}
                >
                  <ChevronRight
                    size={12}
                    className={cn("transition-transform", !overdueCollapsed && "rotate-90")}
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
            {completedTodayPages.length > 0 && (
              <>
                <button
                  className="flex w-full items-center gap-1.5 border-t border-border px-3 py-1.5 text-left text-xs font-medium text-muted-foreground hover:bg-accent/30"
                  onClick={() => setCompletedCollapsed((v) => !v)}
                >
                  <ChevronRight
                    size={12}
                    className={cn("transition-transform", !completedCollapsed && "rotate-90")}
                  />
                  Completed
                  <span className="ml-1 tabular-nums">· {completedTodayPages.length}</span>
                </button>
                {!completedCollapsed && completedTodayPages.map(renderPageItem)}
              </>
            )}
          </>
        ) : (
          // Folder / Inbox views: sortable list with DnD
          <SortableContext items={pageIds} strategy={verticalListSortingStrategy}>
            {visiblePages.map((page) => (
              <Fragment key={page.id}>
                {insertBeforeId === page.id && <InsertionLine />}
                {renderPageItem(page)}
              </Fragment>
            ))}
            {insertBeforeId === null && <InsertionLine />}
          </SortableContext>
        )}
      </div>

      {/* Drag handle — right edge */}
      <div
        className="absolute top-0 right-0 h-full w-1 cursor-col-resize transition-colors hover:bg-primary/30"
        onMouseDown={onResizeStart}
      />

      {pendingDelete && (
        <PageDeleteDialog
          pageTitle={pendingDelete.title}
          onConfirm={handleDeleteConfirm}
          onCancel={handleDeleteCancel}
        />
      )}
    </div>
  );
}
