import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Check } from "lucide-react";
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
import { useInlineRename } from "@/shared/hooks/useInlineRename";
import type { Folder, Page } from "@pikos/core";

function formatDate(iso: string): string {
  // Date-only strings ('YYYY-MM-DD') must be parsed as local, not UTC.
  // new Date('YYYY-MM-DD') treats them as UTC midnight, shifting the displayed
  // date by one day for users west of UTC (e.g. Pacific = Mar 8 → Mar 7).
  const isAllDay = iso.length === 10;
  const date = isAllDay
    ? new Date(parseInt(iso.slice(0, 4)), parseInt(iso.slice(5, 7)) - 1, parseInt(iso.slice(8, 10)))
    : new Date(iso);
  const now = new Date();
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    ...(date.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}),
  });
}

interface PageListItemProps {
  page: Page;
  isActive: boolean;
  isRenaming: boolean;
  folders: Folder[];
  onSelect: () => void;
  onRenameStart: () => void;
  onRenameCommit: (title: string) => void;
  onRenameCancel: () => void;
  onDelete: () => void;
  onMoveToFolder: (folderId: string | null) => void;
  onToggleStatus: () => void;
}

export function PageListItem({
  page,
  isActive,
  isRenaming,
  folders,
  onSelect,
  onRenameStart,
  onRenameCommit,
  onRenameCancel,
  onDelete,
  onMoveToFolder,
  onToggleStatus,
}: PageListItemProps) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useSortable({
    id: page.id,
    data: { type: "page" },
    disabled: isRenaming,
    transition: null,
  });
  const { inputRef, prepareRenameFromMenu, contextMenuContentProps } = useInlineRename(isRenaming);

  const isDone = page.status === "done";

  function commit() {
    const trimmed = inputRef.current?.value.trim() ?? "";
    if (trimmed) onRenameCommit(trimmed);
    else onRenameCancel();
  }

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          ref={setNodeRef}
          style={{
            transform: CSS.Transform.toString(transform),
            opacity: isDragging ? 0 : 1,
          }}
          {...attributes}
          {...listeners}
          className={cn(
            "flex cursor-pointer items-start gap-3 border-b border-border px-3 py-3 text-sm select-none",
            isActive ? "bg-accent text-accent-foreground" : "hover:bg-accent/50"
          )}
          onClick={isRenaming ? undefined : onSelect}
          onDoubleClick={(e) => {
            e.stopPropagation();
            onRenameStart();
          }}
        >
          {/* Checkbox */}
          <button
            className={cn(
              "mt-0.5 flex h-[13px] w-[13px] shrink-0 items-center justify-center rounded-[2px] border transition-colors",
              isDone
                ? "border-foreground/40 bg-foreground/10"
                : "border-muted-foreground/40 hover:border-foreground/60"
            )}
            onClick={(e) => {
              e.stopPropagation();
              onToggleStatus();
            }}
          >
            {isDone && <Check size={8} strokeWidth={2.5} />}
          </button>

          {/* Content */}
          <div className="min-w-0 flex-1">
            <div className="flex items-start justify-between gap-2">
              <div className="relative min-w-0 flex-1">
                <span
                  className={cn(
                    "block truncate leading-snug font-medium",
                    isRenaming && "invisible",
                    isDone && "text-muted-foreground line-through"
                  )}
                >
                  {page.title || "Untitled"}
                </span>
                {isRenaming && (
                  <input
                    ref={inputRef}
                    className="absolute inset-0 w-full border-0 bg-transparent p-0 text-sm leading-snug font-medium text-foreground outline-none"
                    defaultValue={page.title}
                    onBlur={commit}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        commit();
                      } else if (e.key === "Escape") {
                        e.preventDefault();
                        onRenameCancel();
                      }
                    }}
                    onClick={(e) => e.stopPropagation()}
                  />
                )}
              </div>
              {page.scheduledStart && (
                <span className="shrink-0 text-[11px] leading-snug text-muted-foreground">
                  {formatDate(page.scheduledStart)}
                </span>
              )}
            </div>
            {page.subtitle && (
              <p className="mt-0.5 truncate text-xs text-muted-foreground">{page.subtitle}</p>
            )}
          </div>
        </div>
      </ContextMenuTrigger>

      <ContextMenuContent {...contextMenuContentProps}>
        <ContextMenuItem onSelect={() => prepareRenameFromMenu(onRenameStart)}>
          Rename
        </ContextMenuItem>
        <ContextMenuSub>
          <ContextMenuSubTrigger>Move to Folder</ContextMenuSubTrigger>
          <ContextMenuSubContent>
            <ContextMenuItem
              onSelect={() => onMoveToFolder(null)}
              className={cn(page.folderId === null && "font-medium")}
            >
              Inbox
            </ContextMenuItem>
            {folders.map((folder) => (
              <ContextMenuItem
                key={folder.id}
                onSelect={() => onMoveToFolder(folder.id)}
                className={cn(page.folderId === folder.id && "font-medium")}
              >
                <span
                  className="mr-2 h-2 w-2 shrink-0 rounded-full"
                  style={{
                    backgroundColor: folder.color ?? "hsl(var(--muted-foreground) / 0.4)",
                  }}
                />
                {folder.name}
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
