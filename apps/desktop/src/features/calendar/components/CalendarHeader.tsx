import type { CalendarDayCount, CalendarViewMode } from "@pikos/core";
import { buildCalendarDays } from "@pikos/core";
import { addDays, format, isSameMonth, isWithinInterval, startOfDay } from "date-fns";
import { CalendarRange, ChevronLeft, ChevronRight, Grid3x3 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { KeyboardShortcut } from "@/shared/components/KeyboardShortcut";
import { useKeyboardShortcut } from "@/shared/keyboard/useKeyboard";

interface CalendarHeaderProps {
  dayCount: CalendarDayCount;
  onNextWeek: () => void;
  onPrevWeek: () => void;
  onToday: () => void;
  referenceDate: Date;
  /** Which calendar shape is rendered — drives the label, the nav wording and
   * the "current period" test behind the Today button. */
  viewMode: CalendarViewMode;
  onViewModeChange: (v: CalendarViewMode) => void;
}

/** Inner navigation content for the calendar — rendered as children of RightPanelHeader. */
export function CalendarHeader({
  dayCount,
  onNextWeek,
  onPrevWeek,
  onToday,
  onViewModeChange,
  referenceDate,
  viewMode,
}: CalendarHeaderProps) {
  const isMonth = viewMode === "month";
  const visibleDays = buildCalendarDays(referenceDate, dayCount);
  const first = visibleDays[0]!;
  const last = visibleDays[visibleDays.length - 1]!;
  const today = startOfDay(new Date());
  // Month view's Today button disables on the visible MONTH, not the visible
  // week — otherwise it stays live all month long while today is already on screen.
  const isCurrentPeriod = isMonth
    ? isSameMonth(today, referenceDate)
    : isWithinInterval(today, { end: addDays(last, 1), start: first });
  const unit = isMonth ? "month" : "week";

  useKeyboardShortcut("ArrowLeft", onPrevWeek, { group: "Calendar", label: `Previous ${unit}` });
  useKeyboardShortcut("ArrowRight", onNextWeek, { group: "Calendar", label: `Next ${unit}` });
  useKeyboardShortcut("t", onToday, { group: "Calendar", label: "Jump to today" });
  useKeyboardShortcut("m", () => onViewModeChange(isMonth ? "time" : "month"), {
    group: "Calendar",
    label: isMonth ? "Switch to time grid" : "Switch to month view",
  });

  // Time grid shows its visible range ("Mar 16 – 22, 2026" / "Mar 30 – Apr 5,
  // 2026"); month view names the month it is padded around.
  const rangeLabel = isMonth
    ? format(referenceDate, "MMMM yyyy")
    : isSameMonth(first, last)
      ? `${format(first, "MMM d")} – ${format(last, "d, yyyy")}`
      : `${format(first, "MMM d")} – ${format(last, "MMM d, yyyy")}`;

  return (
    <>
      <h2
        aria-label={isMonth ? "Visible month" : "Visible week"}
        aria-live="polite"
        className="type-ui flex-1 pl-1 text-foreground"
      >
        {rangeLabel}
      </h2>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            aria-label={`Previous ${unit}`}
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
            Previous {unit} <KeyboardShortcut shortcut="ArrowLeft" />
          </span>
        </TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            aria-label={`Next ${unit}`}
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
            Next {unit} <KeyboardShortcut shortcut="ArrowRight" />
          </span>
        </TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            aria-label={isMonth ? "Jump to current month" : "Jump to current week"}
            className="h-7 px-2 text-xs"
            disabled={isCurrentPeriod}
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
      {/* View switcher — sits beside the range nav. The day count itself stays a
          preference (Settings → Calendar days shown); this only picks the shape. */}
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            aria-label="Time grid view"
            aria-pressed={!isMonth}
            className="h-7 w-7"
            onClick={() => onViewModeChange("time")}
            size="icon"
            variant={isMonth ? "ghost" : "secondary"}
          >
            <CalendarRange size={14} />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          <span className="inline-flex items-center gap-1.5">
            Time grid <KeyboardShortcut shortcut="m" />
          </span>
        </TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            aria-label="Month view"
            aria-pressed={isMonth}
            className="h-7 w-7"
            onClick={() => onViewModeChange("month")}
            size="icon"
            variant={isMonth ? "secondary" : "ghost"}
          >
            <Grid3x3 size={14} />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          <span className="inline-flex items-center gap-1.5">
            Month <KeyboardShortcut shortcut="m" />
          </span>
        </TooltipContent>
      </Tooltip>
    </>
  );
}
