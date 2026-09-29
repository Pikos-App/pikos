import { Check } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * The three sizes a checkbox comes in, each as a `calc` against the interface
 * text scale so the box tracks the type beside it.
 *
 * It is a prop rather than something a caller writes in `className` because a
 * plain `h-3.5` there wins the tailwind-merge and silently pins the box: the
 * calendar's blocks, all-day chips and month chips each did that, and stayed
 * 12–14px while the calendar's own text size moved around them.
 */
const SIZE_CLASS = {
  /** The page list and the editor byline. */
  md: "h-[calc(1rem*var(--ui-text-scale,1))] w-[calc(1rem*var(--ui-text-scale,1))]",
  /** Calendar blocks and all-day chips. */
  sm: "h-[calc(0.875rem*var(--ui-text-scale,1))] w-[calc(0.875rem*var(--ui-text-scale,1))]",
  /** Month chips, and any row too short for the default. */
  xs: "h-[calc(0.75rem*var(--ui-text-scale,1))] w-[calc(0.75rem*var(--ui-text-scale,1))]",
} as const;

interface TaskCheckboxProps {
  checked: boolean;
  onChange: (e: React.MouseEvent) => void;
  /** Stroke color for an unchecked box. Pass it whenever the box sits on a
   *  colored fill: the default neutral border is picked for a plain background
   *  and sinks into a folder-colored chip, worst on the dark theme. Calendar
   *  callers pass `folderColor ?? DEFAULT_EVENT_COLOR`, the same fallback the
   *  chip background uses, so the stroke tracks the accent rather than the fill. */
  borderColor?: string | undefined;
  /** Render as span (inside buttons) or button (standalone). Default: button. */
  as?: "button" | "span";
  /** See `SIZE_CLASS`. Never set the box's height or width in `className`. */
  size?: keyof typeof SIZE_CLASS;
  /** Ceiling in px, for a box whose container cannot grow to hold it. A calendar
   *  block is as tall as its duration, so a short one is smaller than the scaled
   *  box and clipped it to two slivers of its own border. Clamps the sized class
   *  rather than replacing it, so the box still tracks the type until it runs out
   *  of room. */
  maxPx?: number | undefined;
  className?: string | undefined;
}

export function TaskCheckbox({
  as: Tag = "button",
  borderColor,
  checked,
  className,
  maxPx,
  onChange,
  size = "md",
}: TaskCheckboxProps) {
  // When rendered as a `<span>` we're nested inside an interactive parent
  // (a calendar block <button>). Exposing role="checkbox" there trips
  // axe-core's nested-interactive rule. The visual treatment and click
  // handler stay the same — proper "interactive child of button" modeling
  // is part of the listbox/option refactor in the post-launch a11y backlog.
  const isSpan = Tag === "span";
  return (
    <Tag
      aria-checked={isSpan ? undefined : checked}
      aria-label={isSpan ? undefined : checked ? "Mark not done" : "Mark done"}
      className={cn(
        "task-checkbox flex shrink-0 items-center justify-center rounded-sm border-[1.5px] transition-[background-color,border-color] duration-(--transition-fast)",
        SIZE_CLASS[size],
        checked && "border-muted-foreground/40 bg-muted-foreground/40",
        !checked && !borderColor && "border-border-primary",
        className
      )}
      onClick={(e: React.MouseEvent) => {
        e.stopPropagation();
        onChange(e);
      }}
      onMouseDown={(e: React.MouseEvent) => e.stopPropagation()}
      role={isSpan ? undefined : "checkbox"}
      style={{
        ...(!checked && borderColor ? { borderColor } : {}),
        ...(maxPx === undefined ? {} : { maxHeight: maxPx, maxWidth: maxPx }),
      }}
      tabIndex={isSpan ? undefined : -1}
    >
      {checked && <Check className="text-white" size={9} strokeWidth={2} />}
    </Tag>
  );
}
