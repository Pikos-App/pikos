// FolderChip — folder selector chip with searchable popover.
// Used in QuickAddDialog and future inline metadata editing.

import type { Folder } from "@pikos/core";
import { FolderOpen } from "lucide-react";
import { useState } from "react";

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

interface FolderChipProps {
  folders: Folder[];
  /** Currently selected folder ID, or null for Inbox. */
  value: string | null;
  onChange: (folderId: string | null) => void;
}

export function FolderChip({ folders, onChange, value }: FolderChipProps) {
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
    <Popover onOpenChange={handleOpenChange} open={open}>
      <PopoverTrigger asChild>
        <button
          aria-label={`Folder: ${label}`}
          className="inline-flex min-w-0 cursor-pointer items-center gap-1 rounded text-sm text-muted-foreground/60 transition-colors hover:text-muted-foreground focus:outline-none"
        >
          <FolderOpen aria-hidden="true" className="shrink-0" size={13} />
          <span className="max-w-[100px] truncate">{label}</span>
        </button>
      </PopoverTrigger>

      <PopoverContent align="start" className="w-52 p-0">
        <div className="p-1.5">
          <input
            autoCapitalize="off"
            autoComplete="off"
            autoCorrect="off"
            autoFocus
            className="w-full bg-transparent px-2 py-1 text-xs text-foreground outline-none placeholder:text-muted-foreground/40"
            onChange={(event) => setSearchQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") handleOpenChange(false);
            }}
            placeholder="Search folders…"
            value={searchQuery}
          />
        </div>

        <div className="max-h-48 overflow-y-auto border-t border-border/40 py-1">
          <button
            className={cn(
              "flex w-full cursor-pointer items-center px-3 py-1.5 text-sm transition-colors hover:bg-accent",
              value === null ? "font-medium text-foreground" : "text-muted-foreground"
            )}
            onClick={() => {
              onChange(null);
              handleOpenChange(false);
            }}
          >
            Inbox
          </button>

          {filteredFolders.map((folder) => (
            <button
              className={cn(
                "flex w-full cursor-pointer items-center px-3 py-1.5 text-sm transition-colors hover:bg-accent",
                value === folder.id ? "font-medium text-foreground" : "text-muted-foreground"
              )}
              key={folder.id}
              onClick={() => {
                onChange(folder.id);
                handleOpenChange(false);
              }}
            >
              {folder.name}
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
