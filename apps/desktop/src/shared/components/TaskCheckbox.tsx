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
  return (
    <Tag
      aria-checked={checked}
      aria-label={checked ? "Mark not done" : "Mark done"}
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
      role="checkbox"
      style={!checked && borderColor ? { borderColor } : undefined}
      tabIndex={-1}
    >
      {checked && <Check className="text-white" size={9} strokeWidth={2} />}
    </Tag>
  );
}
