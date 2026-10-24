import { type ReactNode, useState } from "react";

import { Popover, PopoverContent } from "@/components/ui/popover";

import { type AnchoredOpen, PickerTrigger } from "./PickerTrigger";

interface SearchablePopoverProps {
  trigger: ReactNode;
  placeholder?: string;
  align?: "start" | "center" | "end";
  className?: string;
  onQueryChange?: (query: string) => void;
  /** Called on Enter keypress in the search input. Receives the trimmed query. */
  onEnter?: (query: string) => void;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  anchored?: AnchoredOpen;
  /**
   * Intercepts Radix's focus-restore on close. When set, the default
   * trigger-refocus is cancelled and this callback fires instead — used by
   * QuickAdd chips to bounce focus back to the dialog's main input.
   */
  onCloseAutoFocus?: () => void;
  children: (opts: { query: string; close: () => void; clearQuery: () => void }) => ReactNode;
}

export function SearchablePopover({
  align = "start",
  anchored,
  children,
  className = "w-52",
  onCloseAutoFocus,
  onEnter,
  onOpenChange,
  onQueryChange,
  open: controlledOpen,
  placeholder = "Search…",
  trigger,
}: SearchablePopoverProps) {
  const [internalOpen, setInternalOpen] = useState(false);
  const [query, setQuery] = useState("");

  const open = anchored !== undefined || (controlledOpen ?? internalOpen);

  function handleOpenChange(next: boolean) {
    if (!next) setQuery("");
    setInternalOpen(next);
    onOpenChange?.(next);
    if (!next) anchored?.onClose();
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
      <PickerTrigger anchored={anchored}>{trigger}</PickerTrigger>

      <PopoverContent
        align={align}
        className={`${className} p-0`}
        {...(onCloseAutoFocus && {
          onCloseAutoFocus: (e: Event) => {
            e.preventDefault();
            onCloseAutoFocus();
          },
        })}
      >
        <div className="p-1.5">
          <input
            autoCapitalize="off"
            autoComplete="off"
            autoCorrect="off"
            autoFocus
            className="w-full bg-transparent px-2 py-1 text-xs text-foreground outline-none placeholder:text-subtle"
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

export function SearchablePopoverItem({
  children,
  className,
  onClick,
  selected,
}: {
  children: ReactNode;
  className?: string;
  onClick: () => void;
  /** Marks the current value. `data-selected` is also what a list scrolls to
   *  when it opens, so pass it even where the styling is not wanted. */
  selected?: boolean;
}) {
  return (
    <button
      className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm transition-colors hover:bg-accent ${
        selected === undefined
          ? ""
          : selected
            ? "font-medium text-foreground"
            : "text-muted-foreground"
      } ${className ?? ""}`}
      data-selected={selected}
      onClick={onClick}
    >
      {children}
    </button>
  );
}
