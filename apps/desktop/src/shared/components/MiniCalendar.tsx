import { ChevronLeft, ChevronRight } from "lucide-react";

import { cn } from "@/lib/utils";

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
const DAY_ABBRS_SUNDAY = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
const DAY_ABBRS_MONDAY = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];

/** Fixed height of the rendered grid — used by parents that pad surrounding
 * content so the next-month transition doesn't shift layout. */
export const CAL_HEIGHT = 48 + 6 * 26;

interface MiniCalendarProps {
  year: number;
  month: number;
  selectedDate: Date | null;
  onSelect: (date: Date) => void;
  onPrev: () => void;
  onNext: () => void;
  weekStartsOn?: 0 | 1;
}

export function MiniCalendar({
  month,
  onNext,
  onPrev,
  onSelect,
  selectedDate,
  weekStartsOn = 1,
  year,
}: MiniCalendarProps) {
  const today = new Date();
  const rawDay = new Date(year, month, 1).getDay();
  // Shift so the grid starts on the correct day (0=Sun or 1=Mon)
  const firstDayOfWeek = (rawDay - weekStartsOn + 7) % 7;
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const dayAbbrs = weekStartsOn === 1 ? DAY_ABBRS_MONDAY : DAY_ABBRS_SUNDAY;

  const cells: (number | null)[] = [];
  for (let dayOfWeek = 0; dayOfWeek < firstDayOfWeek; dayOfWeek++) cells.push(null);
  for (let dayNum = 1; dayNum <= daysInMonth; dayNum++) cells.push(dayNum);
  while (cells.length % 7 !== 0) cells.push(null);

  return (
    <div className="select-none">
      <div className="mb-2 flex items-center">
        <span className="flex-1 text-sm font-semibold tracking-tight">
          {MONTH_NAMES[month]} {year}
        </span>
        <button
          aria-label="Previous month"
          className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
          onClick={onPrev}
        >
          <ChevronLeft size={14} />
        </button>
        <button
          aria-label="Next month"
          className="ml-0.5 flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
          onClick={onNext}
        >
          <ChevronRight size={14} />
        </button>
      </div>

      <div className="grid grid-cols-7">
        {dayAbbrs.map((day) => (
          <div
            className="pb-1 text-center text-[10px] font-medium tracking-wide text-muted-foreground/60"
            key={day}
          >
            {day}
          </div>
        ))}
      </div>

      <div className="grid grid-cols-7">
        {cells.map((dayNum, cellIdx) => {
          if (dayNum === null) return <div className="h-8" key={`blank-${cellIdx}`} />;

          const isTodayDate =
            year === today.getFullYear() &&
            month === today.getMonth() &&
            dayNum === today.getDate();
          const isSelected =
            selectedDate !== null &&
            selectedDate.getFullYear() === year &&
            selectedDate.getMonth() === month &&
            selectedDate.getDate() === dayNum;

          return (
            <button
              aria-label={`${MONTH_NAMES[month]} ${dayNum}, ${year}`}
              aria-pressed={isSelected}
              className="flex h-8 w-full items-center justify-center focus:outline-none"
              key={dayNum}
              onClick={() => onSelect(new Date(year, month, dayNum))}
            >
              <span
                className={cn(
                  "relative flex h-7 w-7 items-center justify-center rounded-full text-sm transition-colors",
                  isSelected
                    ? "font-medium text-primary"
                    : isTodayDate
                      ? "text-foreground hover:text-foreground"
                      : "text-foreground/75 hover:text-foreground"
                )}
              >
                {dayNum}
                {isTodayDate && !isSelected && (
                  <span className="absolute bottom-0 left-1/2 h-[3px] w-[3px] -translate-x-1/2 rounded-full bg-foreground/40" />
                )}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
