// TagsPopover — multi-select tag picker with search + create.
// Used in MetadataHeader byline and QuickAddDialog.
// Popover stays open for multi-select; Escape closes.

import { Check, Hash } from "lucide-react";
import { useState } from "react";

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { SearchablePopover, SearchablePopoverItem } from "@/shared/components/SearchablePopover";

interface TagsPopoverProps {
  /** All tag names in the workspace — for suggestions. */
  allTags: string[];
  /** Currently selected tag names. */
  selected: string[];
  /** Toggle a tag: add if absent, remove if present. Also called for new tag creation. */
  onToggle: (name: string) => void;
}

export function TagsPopover({ allTags, onToggle, selected }: TagsPopoverProps) {
  const [open, setOpen] = useState(false);

  // Trigger label: no # icon when tags selected; show up to 2 names then +N.
  const hasSelected = selected.length > 0;
  const label =
    selected.length === 0
      ? "Tags"
      : selected.length === 1
        ? `#${selected[0]}`
        : selected.length === 2
          ? `#${selected[0]} #${selected[1]}`
          : `#${selected[0]} #${selected[1]} +${selected.length - 2}`;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div>
          <SearchablePopover
            onEnter={(q) => {
              if (q && !allTags.some((t) => t.toLowerCase() === q.toLowerCase())) {
                onToggle(q.toLowerCase());
              }
            }}
            onOpenChange={setOpen}
            open={open}
            placeholder="Search or create…"
            trigger={
              <button
                aria-label={`Tags: ${hasSelected ? selected.join(", ") : "none"}`}
                className={cn(
                  "inline-flex min-w-0 items-center gap-1 rounded text-sm transition-colors hover:text-muted-foreground focus:outline-none",
                  hasSelected ? "text-muted-foreground/80" : "text-muted-foreground/40"
                )}
              >
                {!hasSelected && <Hash aria-hidden="true" className="shrink-0" size={13} />}
                <span className="max-w-[100px] truncate">{label}</span>
              </button>
            }
          >
            {({ clearQuery, query }) => {
              const normalizedQuery = query.trim().toLowerCase();
              const filteredTags = normalizedQuery
                ? allTags.filter((t) => t.toLowerCase().includes(normalizedQuery))
                : allTags;
              const canCreate =
                normalizedQuery.length > 0 &&
                !allTags.some((t) => t.toLowerCase() === normalizedQuery);

              return (
                <>
                  {filteredTags.map((name) => {
                    const isSelected = selected.includes(name);
                    return (
                      <SearchablePopoverItem
                        className={cn(
                          "justify-between",
                          isSelected ? "font-medium text-foreground" : "text-muted-foreground"
                        )}
                        key={name}
                        onClick={() => onToggle(name)}
                      >
                        <span className="truncate">#{name}</span>
                        {isSelected && (
                          <Check className="shrink-0 text-foreground" size={12} strokeWidth={2.5} />
                        )}
                      </SearchablePopoverItem>
                    );
                  })}

                  {canCreate && (
                    <SearchablePopoverItem
                      className="text-muted-foreground"
                      onClick={() => {
                        onToggle(normalizedQuery);
                        clearQuery();
                      }}
                    >
                      <span className="shrink-0">Create</span>
                      <span className="truncate font-medium text-foreground">
                        #{normalizedQuery}
                      </span>
                    </SearchablePopoverItem>
                  )}

                  {filteredTags.length === 0 && !canCreate && (
                    <p className="px-3 py-2 text-xs text-muted-foreground/40">No tags found</p>
                  )}
                </>
              );
            }}
          </SearchablePopover>
        </div>
      </TooltipTrigger>

      {hasSelected && (
        <TooltipContent className="max-w-[260px]" side="bottom">
          {selected.map((t) => `#${t}`).join("  ")}
        </TooltipContent>
      )}
    </Tooltip>
  );
}
