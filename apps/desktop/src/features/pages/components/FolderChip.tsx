// FolderChip — folder selector chip with searchable popover.
// Used in QuickAddDialog and future inline metadata editing.

import type { Folder } from "@pikos/core";
import { Check, FolderOpen, Plus } from "lucide-react";
import { useState } from "react";

import { cn } from "@/lib/utils";
import { SearchablePopover, SearchablePopoverItem } from "@/shared/components/SearchablePopover";
import { useWorkspace } from "@/shared/context/WorkspaceContext";

interface FolderChipProps {
  folders: Folder[];
  /** Currently selected folder ID, or null for Inbox. */
  value: string | null;
  onChange: (folderId: string | null) => void;
}

export function FolderChip({ folders, onChange, value }: FolderChipProps) {
  const { createFolder } = useWorkspace();
  const [open, setOpen] = useState(false);
  const activeFolder = folders.find((folder) => folder.id === value) ?? null;
  const label = activeFolder?.name ?? "Inbox";

  async function handleCreate(name: string) {
    const trimmed = name.trim();
    if (!trimmed) return;
    const folder = await createFolder({ name: trimmed });
    onChange(folder.id);
    setOpen(false);
  }

  return (
    <SearchablePopover
      onEnter={(q) => {
        const exists = folders.find((f) => f.name.toLowerCase() === q.toLowerCase());
        if (exists) {
          onChange(exists.id);
          setOpen(false);
          return;
        }
        void handleCreate(q);
      }}
      onOpenChange={setOpen}
      open={open}
      placeholder="Search or create…"
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
        const normalizedQuery = query.trim().toLowerCase();
        const filteredFolders = normalizedQuery
          ? folders
              .filter((f) => f.name.toLowerCase().includes(normalizedQuery))
              .map((f) => {
                const lower = f.name.toLowerCase();
                const rank =
                  lower === normalizedQuery ? 0 : lower.startsWith(normalizedQuery) ? 1 : 2;
                return { folder: f, rank };
              })
              .sort((a, b) => a.rank - b.rank || a.folder.name.localeCompare(b.folder.name))
              .map((x) => x.folder)
          : folders;
        const canCreate =
          normalizedQuery.length > 0 &&
          !folders.some((f) => f.name.toLowerCase() === normalizedQuery);

        return (
          <>
            {!normalizedQuery && (
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
            )}

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

            {canCreate && (
              <SearchablePopoverItem
                className="justify-between text-muted-foreground"
                onClick={() => void handleCreate(query)}
              >
                <span className="truncate font-medium text-foreground">{query.trim()}</span>
                <Plus className="shrink-0 text-muted-foreground" size={12} strokeWidth={2.5} />
              </SearchablePopoverItem>
            )}

            {filteredFolders.length === 0 && !canCreate && (
              <p className="px-3 py-2 text-xs text-muted-foreground/40">No folders found</p>
            )}
          </>
        );
      }}
    </SearchablePopover>
  );
}
