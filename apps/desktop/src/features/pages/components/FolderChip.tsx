// FolderChip — folder selector chip with searchable popover.
// Used in QuickAddDialog and future inline metadata editing.

import type { Folder } from "@pikos/core";
import { Check, FolderOpen } from "lucide-react";

import { cn } from "@/lib/utils";
import { SearchablePopover, SearchablePopoverItem } from "@/shared/components/SearchablePopover";

interface FolderChipProps {
  folders: Folder[];
  /** Currently selected folder ID, or null for Inbox. */
  value: string | null;
  onChange: (folderId: string | null) => void;
}

export function FolderChip({ folders, onChange, value }: FolderChipProps) {
  const activeFolder = folders.find((folder) => folder.id === value) ?? null;
  const label = activeFolder?.name ?? "Inbox";

  return (
    <SearchablePopover
      placeholder="Search folders…"
      trigger={
        <button
          aria-label={`Folder: ${label}`}
          className="inline-flex min-w-0 items-center gap-1 rounded text-sm text-muted-foreground/60 transition-colors hover:text-muted-foreground focus:outline-none"
        >
          <FolderOpen aria-hidden="true" className="shrink-0" size={13} />
          <span className="max-w-[100px] truncate">{label}</span>
        </button>
      }
    >
      {({ close, query }) => {
        const filteredFolders =
          query.trim().length > 0
            ? folders.filter((f) => f.name.toLowerCase().includes(query.toLowerCase()))
            : folders;

        return (
          <>
            <SearchablePopoverItem
              className={cn(
                "justify-between",
                value === null ? "font-medium text-foreground" : "text-muted-foreground"
              )}
              onClick={() => {
                onChange(null);
                close();
              }}
            >
              <span>Inbox</span>
              {value === null && (
                <Check className="shrink-0 text-foreground" size={12} strokeWidth={2.5} />
              )}
            </SearchablePopoverItem>

            {filteredFolders.map((folder) => {
              const isSelected = value === folder.id;
              return (
                <SearchablePopoverItem
                  className={cn(
                    "justify-between",
                    isSelected ? "font-medium text-foreground" : "text-muted-foreground"
                  )}
                  key={folder.id}
                  onClick={() => {
                    onChange(folder.id);
                    close();
                  }}
                >
                  <span className="truncate">{folder.name}</span>
                  {isSelected && (
                    <Check className="shrink-0 text-foreground" size={12} strokeWidth={2.5} />
                  )}
                </SearchablePopoverItem>
              );
            })}
          </>
        );
      }}
    </SearchablePopover>
  );
}
