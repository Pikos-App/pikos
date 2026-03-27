// PriorityDropdown — GOO-35.
// Linear-inspired priority selector. Used in MetadataHeader byline + PageListItem badge.

import type { PagePriority } from "@pikos/core";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

// ─── Config ───────────────────────────────────────────────────────────────────

interface PriorityConfig {
  label: string;
  icon: string;
  className: string; // text color
  badgeClassName: string; // badge bg + text for list view
}

const PRIORITY_CONFIG: Record<PagePriority, PriorityConfig> = {
  0: {
    badgeClassName: "text-muted-foreground/40",
    className: "text-muted-foreground/40",
    icon: "—",
    label: "Priority",
  },
  1: {
    badgeClassName: "text-red-500",
    className: "text-red-500",
    icon: "!!",
    label: "Urgent",
  },
  2: {
    badgeClassName: "text-orange-500",
    className: "text-orange-500",
    icon: "!",
    label: "High",
  },
  3: {
    badgeClassName: "text-yellow-500",
    className: "text-yellow-500",
    icon: "··",
    label: "Medium",
  },
  4: {
    badgeClassName: "text-blue-400/80",
    className: "text-blue-400/80",
    icon: "·",
    label: "Low",
  },
};

const ALL_PRIORITIES: PagePriority[] = [0, 1, 2, 3, 4];

// ─── PriorityDropdown ─────────────────────────────────────────────────────────

interface PriorityDropdownProps {
  priority: PagePriority;
  onSelect: (priority: PagePriority) => void;
  /** "byline" = text+icon in metadata header row; "badge" = compact icon-only badge for lists */
  variant?: "byline" | "badge";
}

export function PriorityDropdown({
  onSelect,
  priority,
  variant = "byline",
}: PriorityDropdownProps) {
  const cfg = PRIORITY_CONFIG[priority];

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {variant === "badge" ? (
          // Compact icon badge for page list — only shown when priority ≠ 0
          <button
            aria-label={`Priority: ${cfg.label}`}
            className={cn(
              "flex shrink-0 items-center justify-center rounded px-[3px] text-sm leading-none font-semibold transition-opacity hover:opacity-80 focus:outline-none",
              cfg.badgeClassName
            )}
            onClick={(e) => e.stopPropagation()}
          >
            {cfg.icon}
          </button>
        ) : (
          // Byline chip in MetadataHeader — always visible so user can set priority.
          // Fixed width prevents layout shift when switching between priority labels.
          <button
            aria-label={`Priority: ${cfg.label}`}
            className={cn(
              "inline-flex shrink-0 items-center gap-1 rounded whitespace-nowrap transition-opacity hover:opacity-80 focus:outline-none",
              cfg.className
            )}
          >
            <span className="text-sm font-medium">{cfg.icon}</span>
            <span className="text-sm">{cfg.label}</span>
          </button>
        )}
      </DropdownMenuTrigger>

      <DropdownMenuContent align="start" className="w-44">
        {ALL_PRIORITIES.map((p) => {
          const c = PRIORITY_CONFIG[p];
          return (
            <DropdownMenuItem
              className={cn("gap-2", priority === p && "font-medium")}
              key={p}
              onSelect={() => onSelect(p)}
            >
              <span className={cn("w-5 shrink-0 text-center text-sm font-semibold", c.className)}>
                {c.icon}
              </span>
              <span>{c.label}</span>
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
