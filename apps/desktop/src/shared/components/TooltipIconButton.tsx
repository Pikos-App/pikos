// TooltipIconButton — icon button wrapped in a shadcn Tooltip.
// Shows label + optional keyboard shortcut on hover.

import type { ButtonHTMLAttributes, ReactNode } from "react";

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

import { KeyboardShortcut } from "./KeyboardShortcut";

interface TooltipIconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  shortcut?: string; // canonical format: "mod+shift+c"
  icon: ReactNode;
  side?: "top" | "right" | "bottom" | "left";
}

export function TooltipIconButton({
  className,
  icon,
  label,
  shortcut,
  side = "bottom",
  ...props
}: TooltipIconButtonProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button aria-label={label} className={className} type="button" {...props}>
          {icon}
        </button>
      </TooltipTrigger>
      <TooltipContent side={side}>
        <span className={cn("inline-flex items-center", shortcut && "gap-1.5")}>
          {label}
          {shortcut && <KeyboardShortcut shortcut={shortcut} />}
        </span>
      </TooltipContent>
    </Tooltip>
  );
}
