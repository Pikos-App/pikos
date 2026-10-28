// Popover stays open across toggles for multi-select; Escape closes.

import { Check, Hash } from "lucide-react";
import { useState } from "react";

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { AnchoredOpen } from "@/shared/components/PickerTrigger";
import { SearchablePopover, SearchablePopoverItem } from "@/shared/components/SearchablePopover";

export interface TagsPopoverProps {
  allTags: string[];
  selected: string[];
  /** Toggle a tag: add if absent, remove if present. Also called for new tag creation. */
  onToggle: (name: string) => void;
  /** Fires when the popover transitions from open to closed (any cause). */
  onClose?: () => void;
  anchored?: AnchoredOpen;
}

export function TagsPopover({ allTags, anchored, onClose, onToggle, selected }: TagsPopoverProps) {
  const [open, setOpen] = useState(false);

  // A tag typed into quick add is chosen before any page carries it, so it is in `selected`
  // but not yet in `allTags`. Listed only from `allTags`, the menu left out the one tag the
  // page already had, and offered to create it.
  const listedTags = [...selected.filter((t) => !allTags.includes(t)), ...allTags];

  const hasSelected = selected.length > 0;
  const label =
    selected.length === 0
      ? "Tags"
      : selected.length === 1
        ? `#${selected[0]}`
        : selected.length === 2
          ? `#${selected[0]} #${selected[1]}`
          : `#${selected[0]} #${selected[1]} +${selected.length - 2}`;

  const popover = (
    <SearchablePopover
      {...(anchored && { anchored })}
      onEnter={(q) => {
        if (q && !listedTags.some((t) => t.toLowerCase() === q.toLowerCase())) {
          onToggle(q.toLowerCase());
        }
      }}
      onOpenChange={setOpen}
      {...(onClose && { onCloseAutoFocus: onClose })}
      open={open}
      placeholder="Search or create…"
      trigger={
        <button
          aria-label={`Tags: ${hasSelected ? selected.join(", ") : "none"}`}
          className={cn(
            "inline-flex min-w-0 items-center gap-1 rounded text-sm transition-colors hover:text-muted-foreground focus:outline-none",
            hasSelected ? "text-muted-foreground" : "text-subtle"
          )}
        >
          {!hasSelected && <Hash aria-hidden="true" className="shrink-0" size={13} />}
          <span className="max-w-chip-label truncate">{label}</span>
        </button>
      }
    >
      {({ clearQuery, query }) => {
        const normalizedQuery = query.trim().toLowerCase();
        const filteredTags = normalizedQuery
          ? listedTags.filter((t) => t.toLowerCase().includes(normalizedQuery))
          : listedTags;
        const canCreate =
          normalizedQuery.length > 0 &&
          !listedTags.some((t) => t.toLowerCase() === normalizedQuery);

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
                <span className="truncate font-medium text-foreground">#{normalizedQuery}</span>
              </SearchablePopoverItem>
            )}

            {filteredTags.length === 0 && !canCreate && (
              <p className="px-3 py-2 text-xs text-subtle">No tags found</p>
            )}
          </>
        );
      }}
    </SearchablePopover>
  );

  if (anchored) return popover;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div>{popover}</div>
      </TooltipTrigger>

      {/* Not while the menu is open. The tooltip is anchored to the trigger, which the
          menu opens directly over, so it covered the search field — and typing there is
          the only way to add or create a tag. Once the menu is up it lists the tags
          anyway, so the tooltip has nothing left to say. */}
      {hasSelected && !open && (
        <TooltipContent className="max-w-[260px]" side="bottom">
          {selected.map((t) => `#${t}`).join("  ")}
        </TooltipContent>
      )}
    </Tooltip>
  );
}
