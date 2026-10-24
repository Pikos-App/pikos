import type { PagePriority } from "@pikos/core";
import { PRIORITY_COLORS } from "@pikos/core";
import { Check } from "lucide-react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

interface PriorityConfig {
  label: string;
  icon: string;
}

export const PRIORITY_CONFIG: Record<PagePriority, PriorityConfig> = {
  0: { icon: "", label: "No priority" },
  1: { icon: "!!", label: "Urgent" },
  2: { icon: "!", label: "High" },
  3: { icon: "••", label: "Medium" },
  4: { icon: "•", label: "Low" },
};

export const ALL_PRIORITIES: PagePriority[] = [0, 1, 2, 3, 4];

export interface PriorityDropdownProps {
  priority: PagePriority;
  onSelect: (priority: PagePriority) => void;
  /** "byline" = text+icon in metadata header row; "badge" = compact icon-only badge for lists */
  variant?: "byline" | "badge";
  /** Fires when the menu transitions from open to closed (any cause). */
  onClose?: () => void;
}

export function PriorityDropdown({
  onClose,
  onSelect,
  priority,
  variant = "byline",
}: PriorityDropdownProps) {
  const cfg = PRIORITY_CONFIG[priority];
  const colour = PRIORITY_COLORS[priority];
  const hasPriority = priority !== 0;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {variant === "badge" ? (
          <button
            aria-label={`Priority: ${cfg.label}`}
            className={cn(
              "flex shrink-0 items-center justify-center rounded px-[3px] text-sm leading-none font-semibold transition-opacity hover:opacity-80 focus:outline-none",
              colour
            )}
            onClick={(e) => e.stopPropagation()}
          >
            {hasPriority ? cfg.icon : "—"}
          </button>
        ) : (
          <button
            aria-label={`Priority: ${cfg.label}`}
            className={cn(
              "inline-flex shrink-0 items-center gap-1 rounded whitespace-nowrap transition-opacity hover:opacity-80 focus:outline-none",
              colour
            )}
          >
            <span className="text-sm font-medium">{hasPriority ? cfg.icon : "—"}</span>
            <span className="text-sm">{hasPriority ? cfg.label : "Priority"}</span>
          </button>
        )}
      </DropdownMenuTrigger>

      <DropdownMenuContent
        align="start"
        className="w-44"
        {...(onClose && {
          onCloseAutoFocus: (e: Event) => {
            e.preventDefault();
            onClose();
          },
        })}
      >
        {ALL_PRIORITIES.map((p) => {
          const c = PRIORITY_CONFIG[p];
          const isSelected = priority === p;
          return (
            <DropdownMenuItem
              className={cn(
                "justify-between",
                isSelected ? "font-medium text-foreground" : "text-muted-foreground"
              )}
              key={p}
              onSelect={() => onSelect(p)}
            >
              <span className="flex items-center gap-2">
                <span
                  className={cn(
                    "w-5 shrink-0 text-center text-sm font-semibold",
                    PRIORITY_COLORS[p]
                  )}
                >
                  {c.icon}
                </span>
                <span>{c.label}</span>
              </span>
              {isSelected && (
                <Check className="shrink-0 text-foreground" size={12} strokeWidth={2.5} />
              )}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
