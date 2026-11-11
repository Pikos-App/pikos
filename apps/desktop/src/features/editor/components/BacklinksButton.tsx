import type { PageSummary } from "@pikos/core";
import { Link2 } from "lucide-react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useUI } from "@/shared/context/UIContext";

/** How many pages link here, in the byline after the tags; opens a list of them. */
export function BacklinksButton({ backlinks }: { backlinks: PageSummary[] }) {
  const { openPage } = useUI();

  const label = `Linked from ${backlinks.length} ${backlinks.length === 1 ? "page" : "pages"}`;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          aria-label={label}
          className="inline-flex shrink-0 items-center gap-1 rounded transition-colors hover:text-muted-foreground focus:outline-none"
          title={label}
          type="button"
        >
          <Link2 aria-hidden="true" size={13} />
          {backlinks.length}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-72 w-56 overflow-y-auto">
        {backlinks.map((page) => (
          <DropdownMenuItem key={page.id} onSelect={() => openPage(page)}>
            <span className="truncate">{page.title || "Untitled"}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
