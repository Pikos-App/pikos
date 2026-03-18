import { useState } from "react";
import { useDndMonitor } from "@dnd-kit/core";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Folder as FolderIcon } from "lucide-react";
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
import type { Folder } from "@pikos/core";

const COLORS = [
  { value: "#ef4444", label: "Red" },
  { value: "#f97316", label: "Orange" },
  { value: "#eab308", label: "Yellow" },
  { value: "#22c55e", label: "Green" },
  { value: "#3b82f6", label: "Blue" },
  { value: "#8b5cf6", label: "Purple" },
  { value: "#ec4899", label: "Pink" },
  { value: "#6b7280", label: "Gray" },
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
  pageCount,
  isActive,
  isRenaming,
  onSelect,
  onRenameStart,
  onRenameCommit,
  onRenameCancel,
  onDelete,
  onColorChange,
}: FolderItemProps) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useSortable({
    id: folder.id,
    data: { type: "folder", folderId: folder.id },
    disabled: isRenaming,
    transition: null,
  });
  const { inputRef, prepareRenameFromMenu, contextMenuContentProps } = useInlineRename(isRenaming);

  // Highlight when a page (not a folder) is dragged over this item.
  const [isPageOver, setIsPageOver] = useState(false);
  useDndMonitor({
    onDragOver({ active, over }) {
      setIsPageOver(over?.id === folder.id && active.data.current?.["type"] === "page");
    },
    onDragEnd() {
      setIsPageOver(false);
    },
    onDragCancel() {
      setIsPageOver(false);
    },
  });

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <SidebarListItem
          isActive={isActive}
          isRenaming={isRenaming}
          isDragOver={isPageOver}
          label={folder.name}
          onSelect={onSelect}
          onRenameStart={onRenameStart}
          onRenameCommit={onRenameCommit}
          onRenameCancel={onRenameCancel}
          inputRef={inputRef}
          prefix={
            <FolderIcon
              size={16}
              className="shrink-0"
              style={{ color: folder.color ?? undefined }}
            />
          }
          className="items-center gap-2"
          dragRef={setNodeRef}
          dragStyle={{
            transform: CSS.Transform.toString(transform),
            opacity: isDragging ? 0 : 1,
          }}
          dragProps={{ ...attributes, ...listeners }}
        >
          <span className="min-w-0 flex-1 truncate">{folder.name}</span>
          {pageCount !== undefined && pageCount > 0 && (
            <span className="shrink-0 text-[11px] text-muted-foreground/60 tabular-nums">
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
            {COLORS.map(({ value, label }) => (
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
