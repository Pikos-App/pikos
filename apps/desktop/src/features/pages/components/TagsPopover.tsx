// TagsPopover — multi-select tag picker with search + create.
// Used in MetadataHeader byline and QuickAddDialog.
// Popover stays open for multi-select; Escape closes.

import { useState } from "react";
import { Check, Hash } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

interface TagsPopoverProps {
  /** All tag names in the workspace — for suggestions. */
  allTags: string[];
  /** Currently selected tag names. */
  selected: string[];
  /** Toggle a tag: add if absent, remove if present. Also called for new tag creation. */
  onToggle: (name: string) => void;
}

export function TagsPopover({ allTags, selected, onToggle }: TagsPopoverProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  function handleOpenChange(next: boolean) {
    setOpen(next);
    if (!next) setQuery("");
  }

  const normalizedQuery = query.trim().toLowerCase();

  const filteredTags = normalizedQuery
    ? allTags.filter((t) => t.toLowerCase().includes(normalizedQuery))
    : allTags;

  // Show "Create" option when query doesn't match any existing tag exactly.
  const canCreate =
    normalizedQuery.length > 0 && !allTags.some((t) => t.toLowerCase() === normalizedQuery);

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
    <Popover open={open} onOpenChange={handleOpenChange}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <button
              className={cn(
                "inline-flex min-w-0 cursor-pointer items-center gap-1 rounded text-sm transition-colors hover:text-muted-foreground focus:outline-none",
                hasSelected ? "text-muted-foreground/80" : "text-muted-foreground/40"
              )}
              aria-label={`Tags: ${hasSelected ? selected.join(", ") : "none"}`}
            >
              {!hasSelected && <Hash size={13} className="shrink-0" aria-hidden="true" />}
              <span className="max-w-[100px] truncate">{label}</span>
            </button>
          </PopoverTrigger>
        </TooltipTrigger>

        {hasSelected && (
          <TooltipContent side="bottom" className="max-w-[260px]">
            {selected.map((t) => `#${t}`).join("  ")}
          </TooltipContent>
        )}
      </Tooltip>

      <PopoverContent align="start" className="w-52 p-0">
        <div className="p-1.5">
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") handleOpenChange(false);
              if (e.key === "Enter" && canCreate) {
                onToggle(normalizedQuery);
                setQuery("");
              }
            }}
            placeholder="Search or create…"
            className="w-full bg-transparent px-2 py-1 text-xs text-foreground outline-none placeholder:text-muted-foreground/40"
          />
        </div>

        <div className="max-h-48 overflow-y-auto border-t border-border/40 py-1">
          {filteredTags.map((name) => {
            const isSelected = selected.includes(name);
            return (
              <button
                key={name}
                onClick={() => onToggle(name)}
                className="flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-sm transition-colors hover:bg-accent"
              >
                <Check
                  size={12}
                  strokeWidth={2.5}
                  className={cn("shrink-0", isSelected ? "text-foreground" : "text-transparent")}
                />
                <span className={isSelected ? "text-foreground" : "text-muted-foreground"}>
                  #{name}
                </span>
              </button>
            );
          })}

          {canCreate && (
            <button
              onClick={() => {
                onToggle(normalizedQuery);
                setQuery("");
              }}
              className="flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-accent"
            >
              <Check size={12} strokeWidth={2.5} className="shrink-0 text-transparent" />
              <span>
                Create <span className="font-medium text-foreground">#{normalizedQuery}</span>
              </span>
            </button>
          )}

          {filteredTags.length === 0 && !canCreate && (
            <p className="px-3 py-2 text-xs text-muted-foreground/40">No tags found</p>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
