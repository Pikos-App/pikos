import { Check } from "lucide-react";

import { cn } from "@/lib/utils";

interface TaskCheckboxProps {
  checked: boolean;
  onChange: (e: React.MouseEvent) => void;
  /** Override the default border color (e.g. for priority or folder colors). */
  borderColor?: string | undefined;
  /** Render as span (inside buttons) or button (standalone). Default: button. */
  as?: "button" | "span";
  className?: string | undefined;
}

export function TaskCheckbox({
  as: Tag = "button",
  borderColor,
  checked,
  className,
  onChange,
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
        "task-checkbox flex h-4 w-4 shrink-0 items-center justify-center rounded-sm border-[1.5px] transition-[background-color,border-color] duration-(--transition-fast)",
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
      style={!checked && borderColor ? { borderColor } : undefined}
      tabIndex={isSpan ? undefined : -1}
    >
      {checked && <Check className="text-white" size={9} strokeWidth={2} />}
    </Tag>
  );
}
