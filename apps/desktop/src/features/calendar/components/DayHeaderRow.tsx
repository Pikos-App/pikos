import { format, isSameDay } from "date-fns";

import { cn } from "@/lib/utils";

function isWeekend(day: Date) {
  const d = day.getDay();
  return d === 0 || d === 6;
}

export interface DayHeaderRowProps {
  days: Date[];
  today: Date;
  onCreateDragStart: (args: { clientX: number; clientY: number; dayIndex: number }) => void;
}

/**
 * Mousedown anywhere on a header cell starts the same drag-to-create gesture
 * as the all-day strip below it, so the header remains a clickable create
 * surface even when the all-day section is scrolled past the fold.
 */
export function DayHeaderRow({ days, onCreateDragStart, today }: DayHeaderRowProps) {
  return (
    <div className="flex shrink-0 border-t border-b border-border/40">
      {/* Gutter spacer aligns with TimeGutter's 56px column. */}
      <div className="w-14 shrink-0" />
      {days.map((day, i) => {
        const isToday = isSameDay(day, today);
        return (
          <div
            aria-label={format(day, "EEEE, MMMM d")}
            className={cn(
              "flex min-w-0 flex-1 cursor-cell items-center justify-center gap-1 border-l border-border/40 py-1.5 first:border-l-0",
              isWeekend(day) ? "bg-white/[0.012]" : ""
            )}
            key={day.toISOString()}
            onMouseDown={(e) => {
              if (e.button !== 0) return;
              e.preventDefault();
              onCreateDragStart({ clientX: e.clientX, clientY: e.clientY, dayIndex: i });
            }}
            role="button"
            tabIndex={-1}
          >
            <span
              className={cn(
                "type-ui-sm tracking-wide uppercase",
                isToday ? "text-primary" : "text-subtle"
              )}
            >
              {format(day, "EEE")}
            </span>
            <span
              className={cn("type-ui-sm tabular-nums", isToday ? "text-primary" : "text-subtle")}
            >
              {format(day, "d")}
            </span>
          </div>
        );
      })}
    </div>
  );
}
