// OverflowPill — replaces the slot of the rightmost cascaded under-width
// event in a cluster. Renders as a single "+N more" chip; click opens a
// popover listing the hidden events.

import type { PageSummary } from "@pikos/core";
import { useMemo } from "react";

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

import type { OverflowPill as OverflowPillData } from "../utils/calendarUtils";
import { formatTimeRange } from "../utils/calendarUtils";

interface OverflowPillProps {
  pill: OverflowPillData;
  /** All pages on this day — used to look up titles + times for the listed events. */
  pagesById: Map<string, PageSummary>;
  /** Same callback the calendar uses for any event open — opens the page editor. */
  onOpen: (pageId: string) => void;
}

export function OverflowPill({ onOpen, pagesById, pill }: OverflowPillProps) {
  const items = useMemo(() => {
    return pill.pageIds.map((id) => pagesById.get(id)).filter((p): p is PageSummary => p != null);
  }, [pill.pageIds, pagesById]);

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          aria-label={`${pill.pageIds.length} more events`}
          className={cn(
            "absolute z-30 flex items-center justify-center overflow-hidden select-none",
            "type-ui-sm border border-border/60 bg-popover px-1.5 pb-px leading-none whitespace-nowrap text-foreground",
            "transition-colors hover:brightness-110",
            "focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          )}
          onClick={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
          style={{
            height: pill.height,
            left: `${pill.leftPct}%`,
            top: pill.top,
            width: `calc(${pill.widthPct}% - 2px)`,
          }}
        >
          +{pill.pageIds.length} more
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 p-1.5" side="bottom" sideOffset={4}>
        <div className="type-ui-sm px-2 py-1 text-subtle">{items.length} events hidden</div>
        <div className="flex flex-col">
          {items.map((p) => {
            const start = p.scheduledStart ? new Date(p.scheduledStart) : null;
            const end = p.scheduledEnd ? new Date(p.scheduledEnd) : null;
            const time =
              start && end
                ? formatTimeRange(start, end)
                : start
                  ? formatTimeRange(start, start)
                  : "";
            return (
              <button
                className="flex w-full items-center justify-between gap-2 rounded-sm px-2 py-1.5 text-left hover:bg-accent"
                key={p.id}
                onClick={(e) => {
                  e.stopPropagation();
                  onOpen(p.id);
                }}
                onMouseDown={(e) => e.stopPropagation()}
              >
                <span className="type-body-sm min-w-0 truncate font-medium text-foreground">
                  {p.title || "Untitled"}
                </span>
                <span className="type-ui-sm shrink-0 text-subtle">{time}</span>
              </button>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}
