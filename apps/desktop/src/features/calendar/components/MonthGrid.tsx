import type { MonthCell, PageSummary } from "@pikos/core";
import { MONTH_CELL_MAX_EVENTS, placeMonthCellEvents } from "@pikos/core";
import { format } from "date-fns";

import { cn } from "@/lib/utils";
import { usePages } from "@/shared/context/PagesContext";

import { MonthEventChip } from "./MonthEventChip";

interface MonthGridProps {
  /** Padded month grid — weeks × 7 cells, from `buildMonthGrid`. */
  weeks: MonthCell[][];
  pages: PageSummary[];
  /** Open the full editor for a page (double-click on a chip). */
  onPageDoubleClick: (pageId: string) => void;
  /** Jump the calendar to one day in the time grid. Fired by a click on empty
   * cell space, on the day number, and on the "+K more" pill. */
  onOpenDay: (day: Date) => void;
}

/** Weekday header labels, ordered from whatever day the grid's weeks start on. */
function weekdayLabels(week: MonthCell[]): string[] {
  return week.map((cell) => format(cell.date, "EEE"));
}

/**
 * Month view: the visible month padded to whole weeks, each cell listing its
 * events as chips with a "+K more" pill once the cap is hit.
 *
 * Explicitly out of scope for v1: drag-to-move, resize, and drag-to-create.
 * A month cell has no time axis, so any of those would have to invent a time —
 * the time grid stays the place where scheduling gestures live, and every path
 * out of month view (day number, empty space, overflow pill) lands there.
 */
export function MonthGrid({ onOpenDay, onPageDoubleClick, pages, weeks }: MonthGridProps) {
  const { folders } = usePages();
  // Same folder→colour source the week grid's all-day section reads, so a page
  // keeps one colour across both views.
  const folderColorMap = new Map(
    folders.flatMap((f) => (f.color ? [[f.id, f.color] as [string, string]] : []))
  );
  const headerCells = weeks[0] ? weekdayLabels(weeks[0]) : [];

  return (
    <div aria-label="Month calendar" className="flex min-h-0 flex-1 flex-col" role="region">
      <div className="flex border-b border-border/50">
        {headerCells.map((label) => (
          <div
            className="type-ui-sm flex-1 py-1 text-center font-medium text-subtle uppercase"
            key={label}
          >
            {label}
          </div>
        ))}
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        {weeks.map((week) => (
          <div className="flex min-h-24 flex-1" key={week[0]?.key}>
            {week.map((cell) => {
              const { overflowCount, visible } = placeMonthCellEvents(
                pages,
                cell.date,
                MONTH_CELL_MAX_EVENTS
              );
              const weekend = cell.date.getDay() === 0 || cell.date.getDay() === 6;
              return (
                // eslint-disable-next-line jsx-a11y/no-static-element-interactions -- the cell is a pointer convenience surface, not a control: it must not take a button role because it contains real buttons (the day number, the chips, the overflow pill), and the day-number button is the keyboard-reachable equivalent of clicking it
                <div
                  aria-label={`Events on ${format(cell.date, "EEEE MMMM d, yyyy")}`}
                  className={cn(
                    "flex min-w-0 flex-1 cursor-pointer flex-col gap-px overflow-hidden border-t border-l border-border/40 px-1 pb-1",
                    weekend && "bg-muted/20",
                    !cell.inMonth && "bg-muted/40"
                  )}
                  key={cell.key}
                  onClick={() => onOpenDay(cell.date)}
                  onKeyDown={(e) => {
                    if (e.key !== "Enter" && e.key !== " ") return;
                    e.preventDefault();
                    onOpenDay(cell.date);
                  }}
                >
                  <button
                    aria-label={`Go to ${format(cell.date, "EEEE MMMM d, yyyy")}`}
                    className={cn(
                      "type-ui-sm mx-auto my-0.5 flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full px-1 tabular-nums transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                      cell.inMonth ? "text-foreground" : "text-muted-foreground/60",
                      cell.isToday && "bg-primary font-semibold text-primary-foreground"
                    )}
                    onClick={(e) => {
                      e.stopPropagation();
                      onOpenDay(cell.date);
                    }}
                  >
                    {format(cell.date, "d")}
                  </button>

                  {visible.map((event) => (
                    <MonthEventChip
                      event={event}
                      folderColor={
                        event.page.folderId ? folderColorMap.get(event.page.folderId) : undefined
                      }
                      key={event.key}
                      onDoubleClick={onPageDoubleClick}
                    />
                  ))}

                  {overflowCount > 0 && (
                    <button
                      className="type-ui-sm shrink-0 truncate rounded-sm px-1 text-left text-subtle transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                      onClick={(e) => {
                        e.stopPropagation();
                        onOpenDay(cell.date);
                      }}
                    >
                      +{overflowCount} more
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
