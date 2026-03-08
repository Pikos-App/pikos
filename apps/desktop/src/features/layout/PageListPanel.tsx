// PageListPanel — middle panel (page list for active view). Default 280px, resizable.

import { Fragment, useState } from "react";
import { ChevronRight, Plus } from "lucide-react";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { InsertionLine } from "@/shared/components/InsertionLine";
import { useInsertionLine } from "@/shared/hooks/useInsertionLine";
import { PageListItem } from "@/features/pages/components/PageListItem";
import { PageDeleteDialog } from "@/features/pages/components/PageDeleteDialog";
import { usePageList } from "@/features/pages/hooks/usePageList";
import { groupTodayPages } from "@/features/pages/utils/pageFilters";
import { useUI } from "@/shared/context/UIContext";
import { useMinuteTick } from "@/shared/hooks/useMinuteTick";
import { cn } from "@/lib/utils";

interface PageListPanelProps {
  width: number;
  onResizeStart: (e: React.MouseEvent) => void;
}

export function PageListPanel({ width, onResizeStart }: PageListPanelProps) {
  const {
    visiblePages,
    folders,
    activePage,
    renamingId,
    setRenamingId,
    pendingDelete,
    handleCreatePage,
    handleRenameCommit,
    handleRenameCancel,
    handleDeleteRequest,
    handleDeleteConfirm,
    handleDeleteCancel,
    handleMoveToFolder,
    handleToggleStatus,
    handleSelectPage,
  } = usePageList();
  const { activeViewId } = useUI();

  const pageIds = visiblePages.map((p) => p.id);
  const insertBeforeId = useInsertionLine(pageIds);
  const [overdueCollapsed, setOverdueCollapsed] = useState(true);

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
        isRenaming={renamingId === page.id}
        folders={folders}
        onSelect={() => handleSelectPage(page)}
        onRenameStart={() => setRenamingId(page.id)}
        onRenameCommit={(title) => handleRenameCommit(page.id, title)}
        onRenameCancel={handleRenameCancel}
        onDelete={() => handleDeleteRequest(page)}
        onMoveToFolder={(folderId) => handleMoveToFolder(page.id, folderId)}
        onToggleStatus={() => handleToggleStatus(page.id, page.status)}
      />
    );
  }

  return (
    <div
      className="relative flex shrink-0 flex-col border-r border-border bg-background"
      style={{ width }}
    >
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <span className="text-sm font-semibold text-foreground">
          {activeViewId === "today" ? "Today" : activeViewId === "inbox" ? "Inbox" : "Pages"}
        </span>
        <button
          className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
          title="New Page"
          onClick={() => void handleCreatePage()}
        >
          <Plus size={15} />
        </button>
      </div>

      {/* Page list */}
      <div className="flex flex-col overflow-y-auto">
        {visiblePages.length === 0 ? (
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
                  onClick={() => setOverdueCollapsed((c) => !c)}
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
          </>
        ) : (
          // Folder / Inbox views: sortable list with DnD
          <SortableContext items={pageIds} strategy={verticalListSortingStrategy}>
            {visiblePages.map((page) => (
              <Fragment key={page.id}>
                {insertBeforeId === page.id && <InsertionLine />}
                <PageListItem
                  page={page}
                  isActive={activePage?.id === page.id}
                  isRenaming={renamingId === page.id}
                  folders={folders}
                  onSelect={() => handleSelectPage(page)}
                  onRenameStart={() => setRenamingId(page.id)}
                  onRenameCommit={(title) => handleRenameCommit(page.id, title)}
                  onRenameCancel={handleRenameCancel}
                  onDelete={() => handleDeleteRequest(page)}
                  onMoveToFolder={(folderId) => handleMoveToFolder(page.id, folderId)}
                  onToggleStatus={() => handleToggleStatus(page.id, page.status)}
                />
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
