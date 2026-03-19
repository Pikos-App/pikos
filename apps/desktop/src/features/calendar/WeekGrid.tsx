import type { PageSummary } from "@pikos/core";
import { format, isSameDay } from "date-fns";
import { useEffect, useRef, useState } from "react";

import { cn } from "@/lib/utils";

function isWeekend(day: Date) {
  const d = day.getDay();
  return d === 0 || d === 6;
}

import { AllDaySection } from "./AllDaySection";
import { GRID_START_HOUR, HOUR_HEIGHT } from "./calendarUtils";
import { DayColumn } from "./DayColumn";
import { TimeGutter } from "./TimeGutter";
import { useHeightResize } from "./useHeightResize";

interface WeekGridProps {
  days: Date[];
  isCurrentWeek: boolean;
  onPageClick: (pageId: string) => void;
  pages: PageSummary[];
}

/** Pixel offset from grid top to scroll so 8:00 AM is at the top of the viewport. */
const SCROLL_TO_HOUR = 8;
const INITIAL_SCROLL_TOP = (SCROLL_TO_HOUR - GRID_START_HOUR) * HOUR_HEIGHT;

export function WeekGrid({ days, isCurrentWeek, onPageClick, pages }: WeekGridProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [now, setNow] = useState(() => new Date());
  const today = now;

  const allDay = useHeightResize({
    defaultHeight: 60,
    max: 200,
    min: 30,
    storageKey: "pikos:calendarAllDayHeight",
  });

  // Auto-scroll to 8 AM on mount
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = INITIAL_SCROLL_TOP;
    }
  }, []);

  // Update now every minute (for NowIndicator pass-through)
  useEffect(() => {
    const interval = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Day header — "Mon 16", "Tue 17", etc. Today's date gets a pill highlight */}
      <div className="flex shrink-0 border-b border-border/40">
        {/* Gutter spacer */}
        <div className="w-14 shrink-0" />
        {days.map((day) => {
          const isToday = isSameDay(day, today);
          return (
            <div
              className={cn(
                "flex min-w-0 flex-1 items-center justify-center gap-1 border-l border-border/40 py-1.5 first:border-l-0",
                isWeekend(day) ? "bg-white/[0.012]" : ""
              )}
              key={day.toISOString()}
            >
              <span
                className={cn(
                  "text-xs tracking-wide uppercase",
                  isToday ? "font-medium text-primary" : "text-muted-foreground/70"
                )}
              >
                {format(day, "EEE")}
              </span>
              <span
                className={cn(
                  "text-xs tabular-nums",
                  isToday ? "font-medium text-primary" : "text-muted-foreground/70"
                )}
              >
                {format(day, "d")}
              </span>
            </div>
          );
        })}
      </div>

      {/* All-day row — includes date numbers at top of each column */}
      <AllDaySection
        days={days}
        height={allDay.height}
        onPageClick={onPageClick}
        onResizeStart={allDay.onResizeStart}
        pages={pages}
      />

      {/* Scrollable time grid */}
      <div className="min-h-0 flex-1 overflow-y-auto" ref={scrollRef}>
        <div className="flex">
          <TimeGutter />
          <div className="flex flex-1">
            {days.map((day) => (
              <DayColumn
                day={day}
                isCurrentWeek={isCurrentWeek}
                key={day.toISOString()}
                now={now}
                onPageClick={onPageClick}
                pages={pages}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
