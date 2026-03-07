import { useEffect, useRef } from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { cn } from "@/lib/utils";
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
  onSelect,
  onRenameStart,
  onRenameCommit,
  onRenameCancel,
  onDelete,
  onColorChange,
}: FolderItemProps) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useSortable({
    id: folder.id,
    disabled: isRenaming,
    transition: null,
  });
  const inputRef = useRef<HTMLInputElement>(null);
  // Set when rename is triggered from the context menu so we can suppress
  // Radix's onCloseAutoFocus, which would steal focus back from the input.
  const suppressMenuFocusRestoreRef = useRef(false);

  useEffect(() => {
    if (isRenaming) {
      requestAnimationFrame(() => {
        if (inputRef.current) {
          inputRef.current.value = folder.name;
          inputRef.current.focus();
          inputRef.current.select();
        }
      });
    }
  }, [isRenaming, folder.name]);

  function commitRename() {
    const trimmed = inputRef.current?.value.trim() ?? "";
    if (trimmed) onRenameCommit(trimmed);
    else onRenameCancel();
  }

  function handleRenameFromMenu() {
    suppressMenuFocusRestoreRef.current = true;
    onRenameStart();
  }

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          ref={setNodeRef}
          style={{
            transform: CSS.Transform.toString(transform),
            opacity: isDragging ? 0.5 : 1,
          }}
          {...attributes}
          {...listeners}
          className={cn(
            "flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm select-none",
            isActive
              ? "bg-accent text-accent-foreground"
              : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
          )}
          onClick={isRenaming ? undefined : onSelect}
          onDoubleClick={(e) => {
            e.stopPropagation();
            onRenameStart();
          }}
        >
          <span
            className="h-2 w-2 shrink-0 rounded-full"
            style={{ backgroundColor: folder.color ?? "hsl(var(--muted-foreground) / 0.4)" }}
          />
          {isRenaming ? (
            <input
              ref={inputRef}
              className="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none"
              defaultValue={folder.name}
              onBlur={commitRename}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  commitRename();
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  onRenameCancel();
                }
              }}
              onClick={(e) => e.stopPropagation()}
            />
          ) : (
            <span className="min-w-0 flex-1 truncate">{folder.name}</span>
          )}
        </div>
      </ContextMenuTrigger>

      <ContextMenuContent
        onCloseAutoFocus={(e) => {
          if (suppressMenuFocusRestoreRef.current) {
            e.preventDefault();
            suppressMenuFocusRestoreRef.current = false;
          }
        }}
      >
        <ContextMenuItem onSelect={handleRenameFromMenu}>Rename</ContextMenuItem>
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
