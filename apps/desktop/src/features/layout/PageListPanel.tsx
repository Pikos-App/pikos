// PageListPanel — middle panel (page list for active view). Default 280px, resizable.

import { Fragment } from "react";
import { Plus } from "lucide-react";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { InsertionLine } from "@/shared/components/InsertionLine";
import { useInsertionLine } from "@/shared/hooks/useInsertionLine";
import { PageListItem } from "@/features/pages/components/PageListItem";
import { PageDeleteDialog } from "@/features/pages/components/PageDeleteDialog";
import { usePageList } from "@/features/pages/hooks/usePageList";

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
    handleSelectPage,
  } = usePageList();

  const pageIds = visiblePages.map((p) => p.id);
  const insertBeforeId = useInsertionLine(pageIds);

  return (
    <div
      className="relative flex shrink-0 flex-col border-r border-border bg-background"
      style={{ width }}
    >
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <span className="text-xs font-semibold tracking-wider text-muted-foreground uppercase">
          Pages
        </span>
        <button
          className="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
          title="New Page"
          onClick={() => void handleCreatePage()}
        >
          <Plus size={14} />
        </button>
      </div>

      {/* Page list */}
      <div className="flex flex-col gap-0.5 overflow-y-auto p-1">
        {visiblePages.length === 0 ? (
          <p className="px-2 py-4 text-center text-xs text-muted-foreground italic">No pages</p>
        ) : (
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
