import { useDndMonitor, useDroppable } from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { ArrowUpDown, CalendarDays, Hash, Inbox, Plus, Search, Text } from "lucide-react";
import { Fragment, useState } from "react";
import type React from "react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { InsertionLine } from "@/shared/components/InsertionLine";
import { useUI } from "@/shared/context/UIContext";
import { useInsertionLine } from "@/shared/hooks/useInsertionLine";

import { FolderDeleteDialog } from "./components/FolderDeleteDialog";
import { FolderItem } from "./components/FolderItem";
import { SmartViewEntry } from "./components/SmartViewEntry";
import { useFolderList } from "./hooks/useFolderList";
import type { FolderSortOrder } from "./hooks/useFolderList";

export function FolderList() {
  const {
    activeViewId,
    folders,
    handleColorChange,
    handleCreateFolder,
    handleDeleteCancel,
    handleDeleteConfirm,
    handleDeleteRequest,
    handleRenameCommit,
    inboxCount,
    pageCountByFolder,
    pendingDelete,
    renamingId,
    setActiveViewId,
    setRenamingId,
    setSortOrder,
    sortOrder,
    todayCount,
  } = useFolderList();
  const { openSortMenu, setOpenSortMenu } = useUI();

  const SORT_OPTIONS: { value: FolderSortOrder; label: string; icon: React.ReactNode }[] = [
    { icon: <ArrowUpDown size={13} />, label: "Manual", value: "manual" },
    { icon: <Text size={13} />, label: "Alphabetical", value: "alphabetical" },
    { icon: <Hash size={13} />, label: "Page count", value: "page-count" },
  ];

  const folderIds = folders.map((f) => f.id);
  const insertBeforeId = useInsertionLine(folderIds);

  const { setNodeRef: inboxDropRef } = useDroppable({
    data: { folderId: null, type: "folder" },
    id: "inbox-drop",
  });
  const [isPageOverInbox, setIsPageOverInbox] = useState(false);
  useDndMonitor({
    onDragCancel() {
      setIsPageOverInbox(false);
    },
    onDragEnd() {
      setIsPageOverInbox(false);
    },
    onDragOver({ active, over }) {
      setIsPageOverInbox(over?.id === "inbox-drop" && active.data.current?.["type"] === "page");
    },
  });

  return (
    <>
      <div className="flex flex-col gap-0.5 px-1 py-2">
        <SmartViewEntry
          badge={todayCount}
          icon={<CalendarDays size={16} />}
          isActive={activeViewId === "today"}
          label="Today"
          onSelect={() => setActiveViewId("today")}
        />
        <SmartViewEntry
          badge={inboxCount}
          dragRef={inboxDropRef}
          icon={<Inbox size={16} />}
          isActive={activeViewId === "inbox"}
          isDragOver={isPageOverInbox}
          label="Inbox"
          onSelect={() => setActiveViewId("inbox")}
        />

        <div className="mt-4 mb-1 flex items-center justify-between pr-1 pl-2">
          <span className="text-sm font-semibold text-foreground">Folders</span>
          <div className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
            <button
              className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
              title="Search"
            >
              <Search size={13} />
            </button>
            <DropdownMenu
              onOpenChange={(open) => setOpenSortMenu(open ? "folder-sort" : null)}
              open={openSortMenu === "folder-sort"}
            >
              <DropdownMenuTrigger asChild>
                <button
                  className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
                  title="Sort folders"
                >
                  <ArrowUpDown size={13} />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-40">
                {SORT_OPTIONS.map((opt) => (
                  <DropdownMenuItem
                    className="gap-2"
                    data-active={sortOrder === opt.value}
                    key={opt.value}
                    onSelect={() => setSortOrder(opt.value)}
                  >
                    {opt.icon}
                    {opt.label}
                    {sortOrder === opt.value && <span className="ml-auto text-primary">✓</span>}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
            <button
              className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
              onClick={() => void handleCreateFolder()}
              title="New Folder"
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
                onColorChange={(color) => handleColorChange(folder.id, color)}
                onDelete={() => handleDeleteRequest(folder)}
                onRenameCancel={() => setRenamingId(null)}
                onRenameCommit={(name) => handleRenameCommit(folder.id, name)}
                onRenameStart={() => setRenamingId(folder.id)}
                onSelect={() => setActiveViewId(folder.id)}
                pageCount={pageCountByFolder[folder.id] ?? 0}
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
          onCancel={handleDeleteCancel}
          onConfirm={handleDeleteConfirm}
          pageCount={pendingDelete.pageCount}
        />
      )}
    </>
  );
}
