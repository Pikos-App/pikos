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
import { SidebarListItem } from "@/shared/components/SidebarListItem";
import { useInlineRename } from "@/shared/hooks/useInlineRename";
import type { Folder, Page } from "@pikos/core";

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
}: PageListItemProps) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useSortable({
    id: page.id,
    data: { type: "page" },
    disabled: isRenaming,
    transition: null,
  });
  const { inputRef, prepareRenameFromMenu, contextMenuContentProps } = useInlineRename(isRenaming);

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <SidebarListItem
          isActive={isActive}
          isRenaming={isRenaming}
          label={page.title}
          onSelect={onSelect}
          onRenameStart={onRenameStart}
          onRenameCommit={onRenameCommit}
          onRenameCancel={onRenameCancel}
          inputRef={inputRef}
          className="flex-col gap-0.5"
          dragRef={setNodeRef}
          dragStyle={{
            transform: CSS.Transform.toString(transform),
            opacity: isDragging ? 0 : 1,
          }}
          dragProps={{ ...attributes, ...listeners }}
        >
          <span className="truncate font-medium">{page.title || "Untitled"}</span>
          {page.subtitle && (
            <span className="truncate text-xs text-muted-foreground">{page.subtitle}</span>
          )}
        </SidebarListItem>
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
