// FolderChip — folder selector chip with searchable popover.
// Used in QuickAddDialog and future inline metadata editing.

import { useState } from "react";
import { FolderOpen } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import type { Folder } from "@pikos/core";

interface FolderChipProps {
  folders: Folder[];
  /** Currently selected folder ID, or null for Inbox. */
  value: string | null;
  onChange: (folderId: string | null) => void;
}

export function FolderChip({ folders, value, onChange }: FolderChipProps) {
  const [open, setOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");

  function handleOpenChange(next: boolean) {
    setOpen(next);
    if (!next) setSearchQuery("");
  }

  const filteredFolders =
    searchQuery.trim().length > 0
      ? folders.filter((folder) => folder.name.toLowerCase().includes(searchQuery.toLowerCase()))
      : folders;

  const activeFolder = folders.find((folder) => folder.id === value) ?? null;
  const label = activeFolder?.name ?? "Inbox";

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <button
          className="inline-flex cursor-pointer items-center gap-1 rounded text-sm text-muted-foreground/60 transition-colors hover:text-muted-foreground focus:outline-none"
          aria-label={`Folder: ${label}`}
        >
          <FolderOpen size={13} aria-hidden="true" />
          <span>{label}</span>
        </button>
      </PopoverTrigger>

      <PopoverContent align="start" className="w-52 p-0">
        <div className="p-1.5">
          <input
            autoFocus
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") handleOpenChange(false);
            }}
            placeholder="Search folders…"
            className="w-full bg-transparent px-2 py-1 text-xs text-foreground outline-none placeholder:text-muted-foreground/40"
          />
        </div>

        <div className="max-h-48 overflow-y-auto border-t border-border/40 py-1">
          <button
            onClick={() => {
              onChange(null);
              handleOpenChange(false);
            }}
            className={cn(
              "flex w-full cursor-pointer items-center px-3 py-1.5 text-sm transition-colors hover:bg-accent",
              value === null ? "font-medium text-foreground" : "text-muted-foreground"
            )}
          >
            Inbox
          </button>

          {filteredFolders.map((folder) => (
            <button
              key={folder.id}
              onClick={() => {
                onChange(folder.id);
                handleOpenChange(false);
              }}
              className={cn(
                "flex w-full cursor-pointer items-center px-3 py-1.5 text-sm transition-colors hover:bg-accent",
                value === folder.id ? "font-medium text-foreground" : "text-muted-foreground"
              )}
            >
              {folder.name}
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
