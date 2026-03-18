// PriorityDropdown — GOO-35.
// Linear-inspired priority selector. Used in MetadataHeader byline + PageListItem badge.

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import type { PagePriority } from "@pikos/core";

// ─── Config ───────────────────────────────────────────────────────────────────

interface PriorityConfig {
  label: string;
  icon: string;
  className: string; // text color
  badgeClassName: string; // badge bg + text for list view
}

const PRIORITY_CONFIG: Record<PagePriority, PriorityConfig> = {
  0: {
    label: "Priority",
    icon: "—",
    className: "text-muted-foreground/40",
    badgeClassName: "text-muted-foreground/40",
  },
  1: {
    label: "Urgent",
    icon: "!!",
    className: "text-red-500",
    badgeClassName: "text-red-500",
  },
  2: {
    label: "High",
    icon: "!",
    className: "text-orange-500",
    badgeClassName: "text-orange-500",
  },
  3: {
    label: "Medium",
    icon: "··",
    className: "text-yellow-500",
    badgeClassName: "text-yellow-500",
  },
  4: {
    label: "Low",
    icon: "·",
    className: "text-blue-400/80",
    badgeClassName: "text-blue-400/80",
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
  priority,
  onSelect,
  variant = "byline",
}: PriorityDropdownProps) {
  const cfg = PRIORITY_CONFIG[priority];

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {variant === "badge" ? (
          // Compact icon badge for page list — only shown when priority ≠ 0
          <button
            className={cn(
              "flex shrink-0 cursor-pointer items-center justify-center rounded px-[3px] text-[11px] leading-none font-semibold transition-opacity hover:opacity-80 focus:outline-none",
              cfg.badgeClassName
            )}
            aria-label={`Priority: ${cfg.label}`}
            onClick={(e) => e.stopPropagation()}
          >
            {cfg.icon}
          </button>
        ) : (
          // Byline chip in MetadataHeader — always visible so user can set priority.
          // Fixed width prevents layout shift when switching between priority labels.
          <button
            className={cn(
              "inline-flex shrink-0 cursor-pointer items-center gap-1 rounded whitespace-nowrap transition-opacity hover:opacity-80 focus:outline-none",
              cfg.className
            )}
            aria-label={`Priority: ${cfg.label}`}
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
              key={p}
              onSelect={() => onSelect(p)}
              className={cn("gap-2", priority === p && "font-medium")}
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
