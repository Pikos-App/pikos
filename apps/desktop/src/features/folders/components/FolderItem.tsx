import { useDndMonitor } from "@dnd-kit/core";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { Folder } from "@pikos/core";
import { Pencil, Trash2 } from "lucide-react";
import { useState } from "react";

import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { SidebarCount } from "@/shared/components/SidebarCount";
import { SidebarListItem } from "@/shared/components/SidebarListItem";
import { useInlineRename } from "@/shared/hooks/useInlineRename";

import { FolderColorSubmenu } from "./FolderColorSubmenu";

export interface FolderItemProps {
  folder: Folder;
  pageCount?: number;
  isActive: boolean;
  isRenaming: boolean;
  onSelect: () => void;
  onRenameStart: () => void;
  onRenameCommit: (name: string) => void;
  onRenameCancel: () => void;
  onDelete: () => void;
  onColorChange: (color: string) => void;
}

export function FolderItem({
  folder,
  isActive,
  isRenaming,
  onColorChange,
  onDelete,
  onRenameCancel,
  onRenameCommit,
  onRenameStart,
  onSelect,
  pageCount,
}: FolderItemProps) {
  const { attributes, isDragging, listeners, setNodeRef, transform } = useSortable({
    data: { folderId: folder.id, type: "folder" },
    disabled: isRenaming,
    id: folder.id,
    transition: null,
  });
  const { contextMenuContentProps, inputRef, prepareRenameFromMenu } = useInlineRename(isRenaming);

  const [isPageOver, setIsPageOver] = useState(false);
  useDndMonitor({
    onDragCancel() {
      setIsPageOver(false);
    },
    onDragEnd() {
      setIsPageOver(false);
    },
    onDragOver({ active, over }) {
      setIsPageOver(over?.id === folder.id && active.data.current?.["type"] === "page");
    },
  });

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <SidebarListItem
          className="items-center gap-2"
          dragProps={{ ...attributes, ...listeners }}
          dragRef={setNodeRef}
          dragStyle={{
            opacity: isDragging ? 0 : 1,
            transform: CSS.Transform.toString(transform),
          }}
          id={folder.id}
          inputRef={inputRef}
          isActive={isActive}
          isDragOver={isPageOver}
          isRenaming={isRenaming}
          label={folder.name}
          onRenameCancel={onRenameCancel}
          onRenameCommit={onRenameCommit}
          onRenameStart={onRenameStart}
          onSelect={onSelect}
          prefix={
            <span
              className="color-dot mt-0.75 h-2 w-2 shrink-0 rounded-sm"
              data-testid="folder-color"
              style={{ backgroundColor: folder.color ?? "var(--text-tertiary)" }}
            />
          }
          tabIndex={-1}
        >
          <span className="min-w-0 flex-1 truncate">{folder.name}</span>
          {pageCount !== undefined && pageCount > 0 && <SidebarCount value={pageCount} />}
        </SidebarListItem>
      </ContextMenuTrigger>

      <ContextMenuContent {...contextMenuContentProps}>
        <ContextMenuItem onSelect={() => prepareRenameFromMenu(onRenameStart)}>
          <Pencil aria-hidden />
          Rename
        </ContextMenuItem>
        <FolderColorSubmenu current={folder.color} onColorChange={onColorChange} />
        <ContextMenuItem className="text-destructive focus:text-destructive" onSelect={onDelete}>
          <Trash2 aria-hidden className="text-destructive" />
          Delete
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
