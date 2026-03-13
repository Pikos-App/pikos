import { Fragment, useState } from "react";
import { useDndMonitor, useDroppable } from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CalendarDays, Inbox, Plus, Search } from "lucide-react";
import { InsertionLine } from "@/shared/components/InsertionLine";
import { useInsertionLine } from "@/shared/hooks/useInsertionLine";
import { FolderItem } from "./components/FolderItem";
import { FolderDeleteDialog } from "./components/FolderDeleteDialog";
import { SmartViewEntry } from "./components/SmartViewEntry";
import { useFolderList } from "./hooks/useFolderList";

export function FolderList() {
  const {
    folders,
    activeViewId,
    setActiveViewId,
    renamingId,
    setRenamingId,
    pendingDelete,
    todayCount,
    inboxCount,
    handleCreateFolder,
    handleRenameCommit,
    handleDeleteRequest,
    handleDeleteConfirm,
    handleDeleteCancel,
    handleColorChange,
  } = useFolderList();

  const folderIds = folders.map((f) => f.id);
  const insertBeforeId = useInsertionLine(folderIds);

  const { setNodeRef: inboxDropRef } = useDroppable({
    id: "inbox-drop",
    data: { type: "folder", folderId: null },
  });
  const [isPageOverInbox, setIsPageOverInbox] = useState(false);
  useDndMonitor({
    onDragOver({ active, over }) {
      setIsPageOverInbox(over?.id === "inbox-drop" && active.data.current?.["type"] === "page");
    },
    onDragEnd() {
      setIsPageOverInbox(false);
    },
    onDragCancel() {
      setIsPageOverInbox(false);
    },
  });

  return (
    <>
      <div className="flex flex-col gap-0.5 px-1 py-2">
        <SmartViewEntry
          label="Today"
          icon={<CalendarDays size={16} />}
          isActive={activeViewId === "today"}
          badge={todayCount}
          onSelect={() => setActiveViewId("today")}
        />
        <SmartViewEntry
          label="Inbox"
          icon={<Inbox size={16} />}
          isActive={activeViewId === "inbox"}
          badge={inboxCount}
          onSelect={() => setActiveViewId("inbox")}
          dragRef={inboxDropRef}
          isDragOver={isPageOverInbox}
        />

        <div className="mt-4 mb-1 flex items-center justify-between pr-1 pl-2">
          <span className="text-sm font-semibold text-foreground">Folders</span>
          <div className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
            <button
              className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
              title="Search"
            >
              <Search size={15} />
            </button>
            <button
              className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
              title="New Folder"
              onClick={() => void handleCreateFolder()}
            >
              <Plus size={15} />
            </button>
          </div>
        </div>

        <SortableContext items={folderIds} strategy={verticalListSortingStrategy}>
          {folders.map((folder) => (
            <Fragment key={folder.id}>
              {insertBeforeId === folder.id && <InsertionLine />}
              <FolderItem
                folder={folder}
                isActive={activeViewId === folder.id}
                isRenaming={renamingId === folder.id}
                onSelect={() => setActiveViewId(folder.id)}
                onRenameStart={() => setRenamingId(folder.id)}
                onRenameCommit={(name) => handleRenameCommit(folder.id, name)}
                onRenameCancel={() => setRenamingId(null)}
                onDelete={() => handleDeleteRequest(folder)}
                onColorChange={(color) => handleColorChange(folder.id, color)}
              />
            </Fragment>
          ))}
          {insertBeforeId === null && <InsertionLine />}
        </SortableContext>

        {folders.length === 0 && (
          <p className="px-2 py-1 text-xs text-muted-foreground italic">No folders yet</p>
        )}
      </div>

      {pendingDelete && (
        <FolderDeleteDialog
          folderName={pendingDelete.folder.name}
          pageCount={pendingDelete.pageCount}
          onConfirm={handleDeleteConfirm}
          onCancel={handleDeleteCancel}
        />
      )}
    </>
  );
}
