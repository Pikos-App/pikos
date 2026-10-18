import type { PageSummary } from "@pikos/core";
import { Link2 } from "lucide-react";
import { useEffect, useState } from "react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useUI } from "@/shared/context/UIContext";
import { useWorkspace } from "@/shared/context/WorkspaceContext";

/** How many pages link here, beside the title; opens a list of them. Hidden when none do. */
export function BacklinksButton({ pageId }: { pageId: string }) {
  const { storage } = useWorkspace();
  const { openPage } = useUI();
  const [backlinks, setBacklinks] = useState<PageSummary[]>([]);

  useEffect(() => {
    if (!storage) return;

    let cancelled = false;
    void storage.listBacklinks(pageId).then((rows) => {
      if (!cancelled) setBacklinks(rows);
    });
    return () => {
      cancelled = true;
    };
  }, [storage, pageId]);

  if (backlinks.length === 0) return null;

  const label = `Linked from ${backlinks.length} ${backlinks.length === 1 ? "page" : "pages"}`;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          aria-label={label}
          className="type-ui-sm mt-2 flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-text-tertiary transition-[background-color,color] duration-[var(--transition-fast)] hover:bg-surface-hover hover:text-text-secondary"
          title={label}
          type="button"
        >
          <Link2 aria-hidden="true" size={13} />
          {backlinks.length}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-h-72 w-56 overflow-y-auto">
        {backlinks.map((page) => (
          <DropdownMenuItem key={page.id} onSelect={() => openPage(page)}>
            <span className="truncate">{page.title || "Untitled"}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
