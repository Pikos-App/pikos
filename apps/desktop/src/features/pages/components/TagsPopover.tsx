// TagsPopover — multi-select tag picker with search + create.
// Used in MetadataHeader byline and QuickAddDialog.
// Popover stays open for multi-select; Escape closes.

import { Check, Hash } from "lucide-react";
import { useState } from "react";

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

export function TagsPopover({ allTags, onToggle, selected }: TagsPopoverProps) {
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
    <Popover onOpenChange={handleOpenChange} open={open}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <button
              aria-label={`Tags: ${hasSelected ? selected.join(", ") : "none"}`}
              className={cn(
                "inline-flex min-w-0 cursor-pointer items-center gap-1 rounded text-sm transition-colors hover:text-muted-foreground focus:outline-none",
                hasSelected ? "text-muted-foreground/80" : "text-muted-foreground/40"
              )}
            >
              {!hasSelected && <Hash aria-hidden="true" className="shrink-0" size={13} />}
              <span className="max-w-[100px] truncate">{label}</span>
            </button>
          </PopoverTrigger>
        </TooltipTrigger>

        {hasSelected && (
          <TooltipContent className="max-w-[260px]" side="bottom">
            {selected.map((t) => `#${t}`).join("  ")}
          </TooltipContent>
        )}
      </Tooltip>

      <PopoverContent align="start" className="w-52 p-0">
        <div className="p-1.5">
          <input
            autoCapitalize="off"
            autoComplete="off"
            autoCorrect="off"
            autoFocus
            className="w-full bg-transparent px-2 py-1 text-xs text-foreground outline-none placeholder:text-muted-foreground/40"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") handleOpenChange(false);
              if (e.key === "Enter" && canCreate) {
                onToggle(normalizedQuery);
                setQuery("");
              }
            }}
            placeholder="Search or create…"
            value={query}
          />
        </div>

        <div className="max-h-48 overflow-y-auto border-t border-border/40 py-1">
          {filteredTags.map((name) => {
            const isSelected = selected.includes(name);
            return (
              <button
                className="flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-sm transition-colors hover:bg-accent"
                key={name}
                onClick={() => onToggle(name)}
              >
                <Check
                  className={cn("shrink-0", isSelected ? "text-foreground" : "text-transparent")}
                  size={12}
                  strokeWidth={2.5}
                />
                <span className={isSelected ? "text-foreground" : "text-muted-foreground"}>
                  #{name}
                </span>
              </button>
            );
          })}

          {canCreate && (
            <button
              className="flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-accent"
              onClick={() => {
                onToggle(normalizedQuery);
                setQuery("");
              }}
            >
              <Check className="shrink-0 text-transparent" size={12} strokeWidth={2.5} />
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
