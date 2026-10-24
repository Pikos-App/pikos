import type { Page } from "@pikos/core";
import {
  computeEndTimeLabel,
  computeScheduleTransition,
  formatClockTime,
  isTimedIso,
  parseLocalISO,
  readTypedTime,
  scheduleAtTypedTime,
} from "@pikos/core";
import { differenceInMinutes, getHours, getMinutes, startOfDay } from "date-fns";
import { X } from "lucide-react";
import { useState } from "react";

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { usePages } from "@/shared/context/PagesContext";

interface ScheduleTimeControlsProps {
  page: Page;
  onShowOnCalendar?: () => void;
}

/**
 * The byline's time: shown only once one is set, and placed by moving the page on the
 * calendar it opens. The typed field beside it takes an exact time and a length, for the
 * minutes a drag snaps past and for anyone not dragging.
 */
export function ScheduleTimeControls({ onShowOnCalendar, page }: ScheduleTimeControlsProps) {
  const { scheduleOnce } = usePages();
  const [typed, setTyped] = useState("");
  const [unreadable, setUnreadable] = useState(false);

  const start = page.scheduledStart ?? null;
  const end = page.scheduledEnd ?? null;
  const isTimed = start !== null && isTimedIso(start);

  function applyTyped() {
    if (typed.trim() === "") return;

    const time = readTypedTime(typed);
    if (!time) {
      setUnreadable(true);
      return;
    }

    const next = scheduleAtTypedTime({ end, start }, time, startOfDay(new Date()));
    void scheduleOnce(page.id, next.start, next.end);
    setTyped("");
  }

  function removeTime() {
    if (!start) return;
    const next = computeScheduleTransition({ end, start }, start.slice(0, 10));
    void scheduleOnce(page.id, next.start, next.end);
  }

  let timeLabel: string | null = null;
  if (isTimed) {
    const startDate = parseLocalISO(start);
    const hour24 = getHours(startDate);
    const minute = getMinutes(startDate);
    const length = end && isTimedIso(end) ? differenceInMinutes(parseLocalISO(end), startDate) : 0;
    timeLabel =
      length > 0
        ? `${formatClockTime(hour24, minute)}–${computeEndTimeLabel(hour24, minute, length)}`
        : formatClockTime(hour24, minute);
  }

  return (
    <>
      {timeLabel !== null && (
        <span className="inline-flex shrink-0 items-center gap-0.5">
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                aria-label={`Time: ${timeLabel}`}
                className="rounded whitespace-nowrap text-muted-foreground transition-colors hover:text-foreground focus:outline-none"
                onClick={onShowOnCalendar}
              >
                {timeLabel}
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">Move it on the calendar</TooltipContent>
          </Tooltip>
          <button
            aria-label="Remove time"
            className="rounded p-0.5 text-subtle transition-colors hover:text-foreground focus:outline-none"
            onClick={removeTime}
          >
            <X aria-hidden="true" size={11} />
          </button>
        </span>
      )}
      <input
        aria-invalid={unreadable}
        aria-label="Type a time"
        autoCapitalize="off"
        autoComplete="off"
        autoCorrect="off"
        className={cn(
          "w-[calc(6rem*var(--ui-text-scale,1))] border-none bg-transparent px-0 outline-none placeholder:text-subtle",
          unreadable ? "text-status-overdue" : "text-foreground/80"
        )}
        onBlur={applyTyped}
        onChange={(event) => {
          setTyped(event.target.value);
          setUnreadable(false);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            applyTyped();
          }
          if (event.key === "Escape") {
            setTyped("");
            setUnreadable(false);
          }
        }}
        placeholder={isTimed ? "Change time" : "Add time"}
        type="text"
        value={typed}
      />
    </>
  );
}
