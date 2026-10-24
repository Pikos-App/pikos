import type { PageSummary } from "@pikos/core";
import { formatTriggerLabel, isDone, isTimedIso, parseLocalISO, scheduleOnDay } from "@pikos/core";
import { addDays, isSameDay, nextMonday, startOfDay } from "date-fns";
import { Calendar } from "lucide-react";
import { useState } from "react";

import { Popover, PopoverContent } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { MiniCalendar } from "@/shared/components/MiniCalendar";
import { useAppSettings } from "@/shared/context/AppSettingsContext";
import { usePages } from "@/shared/context/PagesContext";
import { useMonthNav } from "@/shared/hooks/useMonthNav";

import { type AnchoredOpen, PickerTrigger } from "./PickerTrigger";

const DATE_PRESETS: readonly (readonly [string, (today: Date, day: Date | null) => Date])[] = [
  ["Today", (today) => today],
  ["Tomorrow", (today) => addDays(today, 1)],
  ["+1 day", (today, day) => addDays(day ?? today, 1)],
  ["Next week", (today) => nextMonday(today)],
];

/**
 * The byline's date, also opened from a list row's menu. Its name reads the whole schedule, time included, so a screen reader
 * hears the schedule from one control; picking a day keeps the time and the length.
 */
export function ScheduleDateButton({
  anchored,
  page,
}: {
  anchored?: AnchoredOpen;
  page: PageSummary;
}) {
  const { clearSchedule, scheduleOnce } = usePages();
  const { weekStart } = useAppSettings();
  const start = page.scheduledStart ?? null;
  const parsedStart = start ? parseLocalISO(start) : null;
  const selectedDate = parsedStart ? startOfDay(parsedStart) : null;
  const isTimed = start !== null && isTimedIso(start);
  const monthNav = useMonthNav(parsedStart ?? undefined);
  const [ownOpen, setOwnOpen] = useState(false);
  const open = anchored !== undefined || ownOpen;

  function handleOpenChange(next: boolean) {
    if (anchored) {
      if (!next) anchored.onClose();
      return;
    }

    if (next) monthNav.reset(parsedStart ?? new Date());
    setOwnOpen(next);
  }

  function pick(date: Date) {
    monthNav.reset(date);
    const next = scheduleOnDay({ end: page.scheduledEnd, start }, date);
    void scheduleOnce(page.id, next.start, next.end);
  }

  function clear() {
    void clearSchedule(page.id);
    handleOpenChange(false);
  }

  const schedule = start ? formatTriggerLabel(start, page.scheduledEnd, isDone(page)) : null;
  const dateLabel =
    start && isTimed
      ? formatTriggerLabel(start.slice(0, 10), null, isDone(page)).label
      : (schedule?.label ?? "Set date");

  return (
    <Popover onOpenChange={handleOpenChange} open={open}>
      <PickerTrigger anchored={anchored}>
        <button
          aria-label={schedule ? `Scheduled: ${schedule.label}` : "Set schedule"}
          className={cn(
            "inline-flex shrink-0 items-center gap-1 rounded whitespace-nowrap transition-colors focus:outline-none",
            schedule?.isPast
              ? "text-status-overdue hover:text-status-overdue/80"
              : schedule?.isDueSoon
                ? "text-due-soon hover:text-due-soon/80"
                : schedule
                  ? "text-muted-foreground hover:text-foreground"
                  : "text-subtle hover:text-muted-foreground"
          )}
        >
          <Calendar aria-hidden="true" size={13} />
          <span>{dateLabel}</span>
        </button>
      </PickerTrigger>

      <PopoverContent align="start" aria-label="Schedule picker" className="w-[260px] p-3">
        <div className="mb-3 flex items-start justify-between gap-2 text-xs">
          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
            {DATE_PRESETS.map(([label, resolve]) => {
              const presetDate = resolve(startOfDay(new Date()), selectedDate);
              const isActive = selectedDate !== null && isSameDay(selectedDate, presetDate);
              return (
                <button
                  className={cn(
                    "transition-colors",
                    isActive ? "font-medium text-action" : "text-subtle hover:text-foreground"
                  )}
                  key={label}
                  onClick={() => pick(presetDate)}
                >
                  {label}
                </button>
              );
            })}
          </div>
          {start && (
            <button className="shrink-0 text-subtle hover:text-foreground" onClick={clear}>
              No date
            </button>
          )}
        </div>
        <MiniCalendar
          month={monthNav.month}
          onNext={monthNav.next}
          onPrev={monthNav.prev}
          onSelect={pick}
          selectedDate={selectedDate}
          weekStartsOn={weekStart}
          year={monthNav.year}
        />
      </PopoverContent>
    </Popover>
  );
}
