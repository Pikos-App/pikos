// The parent owns count draft state so blur/Enter still commits when the
// user clicks elsewhere mid-edit (same pattern as RecurrenceCustomEditor).

import { parseLocalISO, type RecurrenceOptions } from "@pikos/core";
import { format } from "date-fns";
import { CalendarDays } from "lucide-react";
import { useState } from "react";

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

import { MiniCalendar } from "../MiniCalendar";

export type RecurrenceEndType = "never" | "until" | "count";

export interface RecurrenceEndsEditorProps {
  options: RecurrenceOptions;
  endType: RecurrenceEndType;
  weekStartsOn: 0 | 1;
  /** Year/month the until-picker calendar should display. Owned by parent so
   * popover open/close transitions seed it from the current until value. */
  untilViewYear: number;
  untilViewMonth: number;
  onUntilViewYearChange: (year: number) => void;
  onUntilViewMonthChange: (month: number) => void;
  countDisplay: string;
  onCountChange: (raw: string) => void;
  onCountFocus: () => void;
  onCountCommit: () => void;
  onCountCancel: () => void;
  onSelectEnd: (type: RecurrenceEndType) => void;
  onUntilSelect: (date: Date) => void;
}

function formatEndDateLabel(iso: string | undefined): string {
  if (!iso) return "Pick date";
  const d = parseLocalISO(iso);
  return format(d, "MMM d, yyyy");
}

export function RecurrenceEndsEditor({
  countDisplay,
  endType,
  onCountCancel,
  onCountChange,
  onCountCommit,
  onCountFocus,
  onSelectEnd,
  onUntilSelect,
  onUntilViewMonthChange,
  onUntilViewYearChange,
  options,
  untilViewMonth,
  untilViewYear,
  weekStartsOn,
}: RecurrenceEndsEditorProps) {
  const [untilCalendarOpen, setUntilCalendarOpen] = useState(false);

  function handleUntilSelect(date: Date) {
    onUntilSelect(date);
    setUntilCalendarOpen(false);
  }

  return (
    <div className="space-y-1.5 border-t border-border/40 px-3 py-2.5">
      <div className="flex items-center gap-1.5">
        <span className="mr-1 text-xs text-muted-foreground/60">Ends</span>
        {(["never", "until", "count"] as const).map((t) => {
          const isActive = endType === t;
          return (
            <button
              className={cn(
                "rounded px-2 py-0.5 text-xs transition-colors",
                isActive
                  ? "bg-primary/15 font-medium text-primary"
                  : "text-foreground/55 hover:bg-accent hover:text-foreground"
              )}
              key={t}
              onClick={() => onSelectEnd(t)}
              type="button"
            >
              {t === "never" ? "Never" : t === "until" ? "On" : "After"}
            </button>
          );
        })}
      </div>

      {endType === "until" && (
        <Popover onOpenChange={setUntilCalendarOpen} open={untilCalendarOpen}>
          <PopoverTrigger asChild>
            <button
              className="inline-flex items-center gap-1.5 rounded border border-border/60 px-2 py-1 text-xs text-foreground transition-colors hover:border-primary/60 focus:outline-none"
              type="button"
            >
              <CalendarDays aria-hidden="true" size={11} />
              <span>{formatEndDateLabel(options.until)}</span>
            </button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-[240px] p-3">
            <MiniCalendar
              month={untilViewMonth}
              onNext={() => {
                if (untilViewMonth === 11) {
                  onUntilViewMonthChange(0);
                  onUntilViewYearChange(untilViewYear + 1);
                } else {
                  onUntilViewMonthChange(untilViewMonth + 1);
                }
              }}
              onPrev={() => {
                if (untilViewMonth === 0) {
                  onUntilViewMonthChange(11);
                  onUntilViewYearChange(untilViewYear - 1);
                } else {
                  onUntilViewMonthChange(untilViewMonth - 1);
                }
              }}
              onSelect={handleUntilSelect}
              selectedDate={options.until ? parseLocalISO(options.until) : null}
              weekStartsOn={weekStartsOn}
              year={untilViewYear}
            />
          </PopoverContent>
        </Popover>
      )}
      {endType === "count" && (
        <div className="flex items-center gap-1.5 text-xs text-foreground/80">
          <span>after</span>
          <input
            aria-label="Occurrence count"
            className="w-12 rounded border border-border/60 bg-transparent py-0.5 text-center text-xs text-foreground transition-colors outline-none placeholder:text-muted-foreground/30 focus:border-primary/60"
            inputMode="numeric"
            onBlur={onCountCommit}
            onChange={(event) => onCountChange(event.target.value.replace(/\D/g, "").slice(0, 4))}
            onFocus={onCountFocus}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                onCountCommit();
                event.currentTarget.blur();
              }
              if (event.key === "Escape") {
                onCountCancel();
                event.currentTarget.blur();
              }
            }}
            placeholder={String(options.count ?? 10)}
            value={countDisplay}
          />
          <span>{options.count === 1 ? "time" : "times"}</span>
        </div>
      )}
    </div>
  );
}
