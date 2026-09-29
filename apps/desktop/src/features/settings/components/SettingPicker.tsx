import { ChevronDown } from "lucide-react";
import { useState } from "react";

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { SearchablePopoverItem } from "@/shared/components/SearchablePopover";

/**
 * The quiet trigger every settings dropdown uses: current value, chevron, border.
 * The chevron is the only thing marking the control as openable — the button is
 * otherwise indistinguishable from a label at this weight.
 */
export function PickerTrigger({
  ariaLabel,
  children,
  className = "",
  ...rest
}: React.ComponentProps<"button"> & {
  /** Must contain the visible value: the row's label is a <p>, not a <label>,
   *  so nothing else associates the two for a screen reader. */
  ariaLabel?: string;
}) {
  return (
    // `rest` is what Radix's asChild hands down — the open handler, aria-expanded
    // and the ref. Dropping it renders a button that does nothing.
    <button
      {...rest}
      {...(ariaLabel !== undefined && { "aria-label": ariaLabel })}
      className={`inline-flex shrink-0 items-center gap-1.5 rounded-md border border-border bg-background px-2.5 py-1 text-xs font-medium transition-colors hover:bg-accent ${className}`}
    >
      {children}
      <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
    </button>
  );
}

/** Scrolls the current value into view when the list opens. A 48-entry time list
 *  otherwise opens at midnight however far from it the setting is. */
function centreSelected(node: HTMLDivElement | null): void {
  if (!node) return;
  const item = node.querySelector<HTMLElement>('[data-selected="true"]');
  if (!item) return;
  node.scrollTop = item.offsetTop - node.clientHeight / 2 + item.offsetHeight / 2;
}

interface SettingPickerProps<T extends string | number> {
  /** Prefix for the accessible name; the selected label is appended to it. */
  label: string;
  options: readonly { id: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
  /** Width of the open list. The trigger is always sized to its own value, so
   *  every picker in Settings reads as the same control whatever it holds. */
  listClassName?: string;
}

/** One-of-many picker for lists too long for `SettingChoice`'s button group. */
export function SettingPicker<T extends string | number>({
  label,
  listClassName = "w-28",
  onChange,
  options,
  value,
}: SettingPickerProps<T>) {
  const [open, setOpen] = useState(false);
  const shown = options.find((o) => o.id === value)?.label ?? String(value);

  return (
    <Popover onOpenChange={setOpen} open={open}>
      <PopoverTrigger asChild>
        <PickerTrigger ariaLabel={`${label}: ${shown}`}>{shown}</PickerTrigger>
      </PopoverTrigger>
      <PopoverContent align="end" className={`${listClassName} p-0`}>
        <div className="max-h-48 overflow-y-auto py-1" ref={centreSelected}>
          {options.map((opt) => (
            <SearchablePopoverItem
              key={String(opt.id)}
              onClick={() => {
                onChange(opt.id);
                setOpen(false);
              }}
              selected={opt.id === value}
            >
              {opt.label}
            </SearchablePopoverItem>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
