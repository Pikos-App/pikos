import type { Folder, PageSummary } from "@pikos/core";
import { pageActions, writableFolders } from "@pikos/core";

import {
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
} from "@/components/ui/context-menu";
import { cn } from "@/lib/utils";

interface PageRowMenuProps {
  page: PageSummary;
  folders: Folder[];
  /** How many pages the menu acts on: the selection the row belongs to, or 1. */
  actsOn: number;
  onCloseAutoFocus: (e: Event) => void;
  onRename: () => void;
  onMoveToFolder: (folderId: string | null) => void;
  /** Absent where the list can't clear a date, which withholds No date. */
  onClearDate?: (() => void) | undefined;
  onDelete: () => void;
}

/** A page row's right-click menu, rendered from `pageActions` so every surface offers the same. */
export function PageRowMenu({
  actsOn,
  folders,
  onClearDate,
  onCloseAutoFocus,
  onDelete,
  onMoveToFolder,
  onRename,
  page,
}: PageRowMenuProps) {
  return (
    <ContextMenuContent onCloseAutoFocus={onCloseAutoFocus}>
      {pageActions(page, actsOn).map((action) => {
        if (!action.offered) return null;
        switch (action.id) {
          case "rename":
            return (
              <ContextMenuItem key={action.id} onSelect={onRename}>
                Rename
              </ContextMenuItem>
            );
          case "move-to-folder":
            return (
              <ContextMenuSub key={action.id}>
                <ContextMenuSubTrigger>Move to folder</ContextMenuSubTrigger>
                <ContextMenuSubContent>
                  <ContextMenuItem
                    className={cn(page.folderId === null && "font-medium")}
                    onSelect={() => onMoveToFolder(null)}
                  >
                    Inbox
                  </ContextMenuItem>
                  {writableFolders(folders).map((folder) => (
                    <ContextMenuItem
                      className={cn(page.folderId === folder.id && "font-medium")}
                      key={folder.id}
                      onSelect={() => onMoveToFolder(folder.id)}
                    >
                      <span
                        className="color-dot mr-2 h-2 w-2 shrink-0 rounded-full"
                        style={{
                          backgroundColor: folder.color ?? "hsl(var(--muted-foreground) / 0.4)",
                        }}
                      />
                      {folder.name}
                    </ContextMenuItem>
                  ))}
                </ContextMenuSubContent>
              </ContextMenuSub>
            );
          case "clear-date":
            return onClearDate ? (
              <ContextMenuItem key={action.id} onSelect={onClearDate}>
                No date
              </ContextMenuItem>
            ) : null;
          case "delete":
            return (
              <ContextMenuItem
                className="text-destructive focus:text-destructive"
                key={action.id}
                onSelect={onDelete}
              >
                {actsOn > 1 ? `Delete ${actsOn} pages` : "Delete"}
              </ContextMenuItem>
            );
        }
      })}
    </ContextMenuContent>
  );
}
