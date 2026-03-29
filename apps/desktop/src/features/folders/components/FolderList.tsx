import { useDndMonitor, useDroppable } from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { ArrowUpDown, CalendarDays, FolderPlus, Hash, Inbox, Plus, Text } from "lucide-react";
import { Fragment, useState } from "react";
import type React from "react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { IconToolbar } from "@/shared/components/IconToolbar";
import { InsertionLine } from "@/shared/components/InsertionLine";
import { TooltipIconButton } from "@/shared/components/TooltipIconButton";
import { useUI } from "@/shared/context/UIContext";
import { useInsertionLine } from "@/shared/hooks/useInsertionLine";

import { useFolderList } from "../hooks/useFolderList";
import type { FolderSortOrder } from "../hooks/useFolderList";
import { FolderDeleteDialog } from "./FolderDeleteDialog";
import { FolderItem } from "./FolderItem";
import { SmartViewEntry } from "./SmartViewEntry";

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

  // ── Keyboard navigation ───────────────────────────────────────────────────

  function handleNavKeyDown(e: React.KeyboardEvent) {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    e.currentTarget.setAttribute("data-keyboard-nav", "1");
    const navIds = ["today", "inbox", ...folders.map((f) => f.id)];
    const dir = e.key === "ArrowDown" ? 1 : -1;
    const currentIdx = navIds.indexOf(activeViewId);
    const newIdx =
      currentIdx === -1
        ? dir === 1
          ? 0
          : navIds.length - 1
        : Math.max(0, Math.min(navIds.length - 1, currentIdx + dir));
    const nextId = navIds[newIdx];
    if (nextId !== undefined) setActiveViewId(nextId);
  }

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
      <div
        aria-label="Views and folders"
        className="flex flex-col gap-0.5 px-1 py-2 focus-visible:rounded focus-visible:ring-1 focus-visible:ring-ring/40 focus-visible:outline-none"
        onKeyDown={handleNavKeyDown}
        onPointerMove={(e) => e.currentTarget.removeAttribute("data-keyboard-nav")}
        role="group"
        tabIndex={0}
      >
        <SmartViewEntry
          badge={todayCount}
          icon={<CalendarDays size={16} />}
          id="nav-today"
          isActive={activeViewId === "today"}
          label="Today"
          onSelect={() => setActiveViewId("today")}
        />
        <SmartViewEntry
          badge={inboxCount}
          dragRef={inboxDropRef}
          icon={<Inbox size={16} />}
          id="nav-inbox"
          isActive={activeViewId === "inbox"}
          isDragOver={isPageOverInbox}
          label="Inbox"
          onSelect={() => setActiveViewId("inbox")}
        />

        <div className="mt-4 mb-1 flex items-center justify-between pr-1 pl-2">
          <span className="type-ui-sm tracking-wide text-subtle uppercase">Folders</span>
          <IconToolbar
            aria-label="Folder actions"
            className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100"
          >
            <DropdownMenu
              onOpenChange={(open) => setOpenSortMenu(open ? "folder-sort" : null)}
              open={openSortMenu === "folder-sort"}
            >
              <Tooltip>
                <TooltipTrigger asChild>
                  <DropdownMenuTrigger asChild>
                    <button
                      aria-label="Sort folders"
                      className="rounded p-1 text-text-tertiary transition-[background-color,color] duration-[var(--transition-fast)] hover:bg-surface-hover hover:text-text-secondary"
                      tabIndex={-1}
                    >
                      <ArrowUpDown size={13} />
                    </button>
                  </DropdownMenuTrigger>
                </TooltipTrigger>
                <TooltipContent side="right">Sort folders</TooltipContent>
              </Tooltip>
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
            <TooltipIconButton
              icon={<Plus size={15} />}
              label="New Folder"
              onClick={() => void handleCreateFolder()}
              side="right"
              tabIndex={-1}
            />
          </IconToolbar>
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
          <button
            className="type-body-sm mx-2 mt-1 flex w-[calc(100%-16px)] items-center gap-2 rounded-md px-2 py-2 text-left text-subtle hover:bg-surface-hover hover:text-foreground"
            onClick={() => void handleCreateFolder()}
          >
            <FolderPlus size={14} strokeWidth={1.5} />
            Create a folder
          </button>
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
