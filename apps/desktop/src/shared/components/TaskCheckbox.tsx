import { Check } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * The three sizes a checkbox comes in, each a `calc` against the interface text scale so the box
 * tracks the type beside it. A prop rather than a `className` because a plain `h-3.5` there wins
 * the tailwind-merge and silently pins the box while the calendar's text size moves around it.
 */
const SIZE_CLASS = {
  md: "h-[calc(1rem*var(--ui-text-scale,1))] w-[calc(1rem*var(--ui-text-scale,1))]",
  sm: "h-[calc(0.875rem*var(--ui-text-scale,1))] w-[calc(0.875rem*var(--ui-text-scale,1))]",
  /** Month chips, and any row too short for the default. */
  xs: "h-[calc(0.75rem*var(--ui-text-scale,1))] w-[calc(0.75rem*var(--ui-text-scale,1))]",
} as const;

interface TaskCheckboxProps {
  checked: boolean;
  onChange: (e: React.MouseEvent) => void;
  /** Stroke color for an unchecked box. Pass it whenever the box sits on a colored fill: the default
   *  neutral border sinks into a folder-colored chip, worst on the dark theme. */
  borderColor?: string | undefined;
  as?: "button" | "span";
  size?: keyof typeof SIZE_CLASS;
  /** Ceiling in px, for a box whose container cannot grow to hold it. A calendar block is as tall
   *  as its duration, so a short one is smaller than the scaled box and would clip it to two
   *  slivers of its own border. Clamps the sized class rather than replacing it, so the box still
   *  tracks the type until it runs out of room. */
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
  // Rendered as a `<span>` the box is nested in an interactive parent (a calendar block <button>),
  // and role="checkbox" there trips axe-core's nested-interactive rule.
  const isSpan = Tag === "span";
  return (
    <Tag
      aria-checked={isSpan ? undefined : checked}
      aria-label={isSpan ? undefined : checked ? "Mark not done" : "Mark done"}
      className={cn(
        "task-checkbox flex shrink-0 items-center justify-center rounded-sm border-[1.5px] [transition:background-color_var(--transition-fast),border-color_var(--transition-fast)]",
        SIZE_CLASS[size],
        checked && "border-muted-foreground/40 bg-muted-foreground/40",
        !checked && !borderColor && "border-border-control",
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
      {/* Always mounted, so the tick draws in when it is checked and not on every
          row that scrolls into view already done. */}
      <Check
        className={cn(
          "text-white [transition:opacity_var(--transition-fast),scale_var(--transition-fast)]",
          checked ? "scale-100 opacity-100" : "scale-50 opacity-0"
        )}
        size={9}
        strokeWidth={2}
      />
    </Tag>
  );
}
