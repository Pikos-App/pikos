import { addDays, format, isSameDay, isSameMonth } from "date-fns";
import { ChevronLeft, ChevronRight } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { KeyboardShortcut } from "@/shared/components/KeyboardShortcut";
import { useKeyboardShortcut } from "@/shared/keyboard/useKeyboard";

import { weekStart } from "./calendarUtils";

interface CalendarHeaderProps {
  onNextWeek: () => void;
  onPrevWeek: () => void;
  onToday: () => void;
  referenceDate: Date;
}

// Inner navigation content for the calendar — rendered as children of RightPanelHeader.
export function CalendarHeader({
  onNextWeek,
  onPrevWeek,
  onToday,
  referenceDate,
}: CalendarHeaderProps) {
  const monday = weekStart(referenceDate);
  const isCurrentWeek = isSameDay(weekStart(new Date()), monday);

  useKeyboardShortcut("ArrowLeft", onPrevWeek);
  useKeyboardShortcut("ArrowRight", onNextWeek);
  useKeyboardShortcut("t", onToday);

  // Show week range: "Mar 16 – 22, 2026" or "Mar 30 – Apr 5, 2026"
  const sunday = addDays(monday, 6);
  const weekLabel = isSameMonth(monday, sunday)
    ? `${format(monday, "MMM d")} – ${format(sunday, "d, yyyy")}`
    : `${format(monday, "MMM d")} – ${format(sunday, "MMM d, yyyy")}`;

  return (
    <>
      <h2 aria-live="polite" className="flex-1 pl-1 text-sm font-medium text-foreground">
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
