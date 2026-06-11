import { addDays, format, isSameMonth, isWithinInterval, startOfDay } from "date-fns";
import { ChevronLeft, ChevronRight } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { KeyboardShortcut } from "@/shared/components/KeyboardShortcut";
import type { CalendarDayCount } from "@/shared/constants/calendar";
import { useKeyboardShortcut } from "@/shared/keyboard/useKeyboard";

import { buildCalendarDays } from "../utils/calendarGeometry";

interface CalendarHeaderProps {
  dayCount: CalendarDayCount;
  onNextWeek: () => void;
  onPrevWeek: () => void;
  onToday: () => void;
  referenceDate: Date;
}

/** Inner navigation content for the calendar — rendered as children of RightPanelHeader. */
export function CalendarHeader({
  dayCount,
  onNextWeek,
  onPrevWeek,
  onToday,
  referenceDate,
}: CalendarHeaderProps) {
  const visibleDays = buildCalendarDays(referenceDate, dayCount);
  const first = visibleDays[0]!;
  const last = visibleDays[visibleDays.length - 1]!;
  const today = startOfDay(new Date());
  const isCurrentWeek = isWithinInterval(today, { end: addDays(last, 1), start: first });

  useKeyboardShortcut("ArrowLeft", onPrevWeek);
  useKeyboardShortcut("ArrowRight", onNextWeek);
  useKeyboardShortcut("t", onToday);

  // Show visible range: "Mar 16 – 22, 2026" or "Mar 30 – Apr 5, 2026"
  const weekLabel = isSameMonth(first, last)
    ? `${format(first, "MMM d")} – ${format(last, "d, yyyy")}`
    : `${format(first, "MMM d")} – ${format(last, "MMM d, yyyy")}`;

  return (
    <>
      <h2
        aria-label="Visible week"
        aria-live="polite"
        className="type-ui flex-1 pl-1 text-foreground"
      >
        {weekLabel}
      </h2>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            aria-label="Previous week"
            className="h-7 w-7"
            onClick={onPrevWeek}
            size="icon"
            variant="ghost"
          >
            <ChevronLeft size={14} />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          <span className="inline-flex items-center gap-1.5">
            Previous week <KeyboardShortcut shortcut="ArrowLeft" />
          </span>
        </TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            aria-label="Next week"
            className="h-7 w-7"
            onClick={onNextWeek}
            size="icon"
            variant="ghost"
          >
            <ChevronRight size={14} />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          <span className="inline-flex items-center gap-1.5">
            Next week <KeyboardShortcut shortcut="ArrowRight" />
          </span>
        </TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            aria-label="Jump to current week"
            className="h-7 px-2 text-xs"
            disabled={isCurrentWeek}
            onClick={onToday}
            size="sm"
            variant="ghost"
          >
            Today
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          <span className="inline-flex items-center gap-1.5">
            Today <KeyboardShortcut shortcut="t" />
          </span>
        </TooltipContent>
      </Tooltip>
    </>
  );
}
