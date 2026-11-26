import type { Folder } from "@pikos/core";
import { writableFolders } from "@pikos/core";
import { FolderOpen } from "lucide-react";

import {
  ContextMenuItem,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
} from "@/components/ui/context-menu";
import { cn } from "@/lib/utils";

/** A page menu's Move to folder submenu: the Inbox, then every folder a page can be filed in. */
export function MoveToFolderSub({
  currentFolderId,
  folders,
  onMoveToFolder,
}: {
  currentFolderId: string | null;
  folders: Folder[];
  onMoveToFolder: (folderId: string | null) => void;
}) {
  return (
    <ContextMenuSub>
      <ContextMenuSubTrigger className="gap-2">
        <FolderOpen aria-hidden />
        Move to folder
      </ContextMenuSubTrigger>
      <ContextMenuSubContent>
        <ContextMenuItem
          className={cn(currentFolderId === null && "font-medium")}
          onSelect={() => onMoveToFolder(null)}
        >
          Inbox
        </ContextMenuItem>
        {writableFolders(folders).map((folder) => (
          <ContextMenuItem
            className={cn(currentFolderId === folder.id && "font-medium")}
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
}
