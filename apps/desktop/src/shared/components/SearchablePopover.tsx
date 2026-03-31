// SearchablePopover — popover with search input and scrollable item list.
// Shared primitive for TagsPopover, FolderChip, and similar pickers.

import { type ReactNode, useState } from "react";

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

interface SearchablePopoverProps {
  /** Trigger element — should be a button or similar interactive element. */
  trigger: ReactNode;
  /** Placeholder text for the search input. */
  placeholder?: string;
  /** Content alignment relative to trigger. */
  align?: "start" | "center" | "end";
  /** Width class for the popover content. */
  className?: string;
  /** Called with the current query whenever it changes. */
  onQueryChange?: (query: string) => void;
  /** Called on Enter keypress in the search input. Receives the trimmed query. */
  onEnter?: (query: string) => void;
  /** Controlled open state. */
  open?: boolean;
  /** Called when open state changes. */
  onOpenChange?: (open: boolean) => void;
  /** Scrollable list content rendered below the search input. */
  children: (opts: { query: string; close: () => void; clearQuery: () => void }) => ReactNode;
}

export function SearchablePopover({
  align = "start",
  children,
  className = "w-52",
  onEnter,
  onOpenChange,
  onQueryChange,
  open: controlledOpen,
  placeholder = "Search…",
  trigger,
}: SearchablePopoverProps) {
  const [internalOpen, setInternalOpen] = useState(false);
  const [query, setQuery] = useState("");

  const open = controlledOpen ?? internalOpen;

  function handleOpenChange(next: boolean) {
    if (!next) setQuery("");
    setInternalOpen(next);
    onOpenChange?.(next);
  }

  function close() {
    handleOpenChange(false);
  }

  function handleQueryChange(value: string) {
    setQuery(value);
    onQueryChange?.(value);
  }

  return (
    <Popover onOpenChange={handleOpenChange} open={open}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>

      <PopoverContent align={align} className={`${className} p-0`}>
        <div className="p-1.5">
          <input
            autoCapitalize="off"
            autoComplete="off"
            autoCorrect="off"
            autoFocus
            className="w-full bg-transparent px-2 py-1 text-xs text-foreground outline-none placeholder:text-muted-foreground/40"
            onChange={(e) => handleQueryChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") close();
              if (e.key === "Enter" && query.trim()) {
                onEnter?.(query.trim());
                setQuery("");
              }
            }}
            placeholder={placeholder}
            value={query}
          />
        </div>

        <div className="max-h-48 overflow-y-auto border-t border-border/40 py-1">
          {children({ clearQuery: () => setQuery(""), close, query })}
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** Standard item button for use inside SearchablePopover. */
export function SearchablePopoverItem({
  children,
  className,
  onClick,
}: {
  children: ReactNode;
  className?: string;
  onClick: () => void;
}) {
  return (
    <button
      className={`flex w-full items-center gap-2 px-3 py-1.5 text-sm transition-colors hover:bg-accent ${className ?? ""}`}
      onClick={onClick}
    >
      {children}
    </button>
  );
}
