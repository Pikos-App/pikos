import { useDndMonitor } from "@dnd-kit/core";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { Folder } from "@pikos/core";
import { Folder as FolderIcon } from "lucide-react";
import { useState } from "react";

import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { SidebarListItem } from "@/shared/components/SidebarListItem";
import { useInlineRename } from "@/shared/hooks/useInlineRename";

const COLORS = [
  { label: "Red", value: "#ef4444" },
  { label: "Orange", value: "#f97316" },
  { label: "Yellow", value: "#eab308" },
  { label: "Green", value: "#22c55e" },
  { label: "Blue", value: "#3b82f6" },
  { label: "Purple", value: "#8b5cf6" },
  { label: "Pink", value: "#ec4899" },
  { label: "Gray", value: "#6b7280" },
] as const;

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

  // Highlight when a page (not a folder) is dragged over this item.
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
            <FolderIcon
              className="shrink-0"
              size={16}
              style={{ color: folder.color ?? undefined }}
            />
          }
          tabIndex={-1}
        >
          <span className="min-w-0 flex-1 truncate">{folder.name}</span>
          {pageCount !== undefined && pageCount > 0 && (
            <span className="shrink-0 text-sm text-muted-foreground/60 tabular-nums">
              {pageCount > 99 ? "99+" : pageCount}
            </span>
          )}
        </SidebarListItem>
      </ContextMenuTrigger>

      <ContextMenuContent {...contextMenuContentProps}>
        <ContextMenuItem onSelect={() => prepareRenameFromMenu(onRenameStart)}>
          Rename
        </ContextMenuItem>
        <ContextMenuSub>
          <ContextMenuSubTrigger>Color</ContextMenuSubTrigger>
          <ContextMenuSubContent>
            {COLORS.map(({ label, value }) => (
              <ContextMenuItem key={value} onSelect={() => onColorChange(value)}>
                <span
                  className="mr-2 h-3 w-3 shrink-0 rounded-full"
                  style={{ backgroundColor: value }}
                />
                {label}
              </ContextMenuItem>
            ))}
          </ContextMenuSubContent>
        </ContextMenuSub>
        <ContextMenuItem className="text-destructive focus:text-destructive" onSelect={onDelete}>
          Delete
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
