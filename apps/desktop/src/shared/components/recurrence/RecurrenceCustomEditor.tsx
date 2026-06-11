// The interval input is draft state committed on blur/Enter — keeps RRULE
// emit out of the per-keystroke path.

import type { RecurrenceFreq, RecurrenceOptions, RecurrenceWeekday } from "@pikos/core";
import { Check, ChevronDown } from "lucide-react";
import { useState } from "react";

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

import { FREQ_UNIT_LABELS, WEEKDAYS } from "./recurrenceConstants";

export interface RecurrenceCustomEditorProps {
  options: RecurrenceOptions | null;
  /** Draft + commit state for the interval input — owned by the parent so
   * blur/Enter still triggers a single emit even when this subcomponent
   * unmounts (e.g. user clicks a preset). */
  intervalDisplay: string;
  intervalFocused: boolean;
  onIntervalChange: (raw: string) => void;
  onIntervalFocus: () => void;
  onIntervalCommit: () => void;
  onIntervalCancel: () => void;
  onSelectFreq: (freq: RecurrenceFreq) => void;
  onToggleWeekday: (day: RecurrenceWeekday) => void;
}

export function RecurrenceCustomEditor({
  intervalDisplay,
  onIntervalCancel,
  onIntervalChange,
  onIntervalCommit,
  onIntervalFocus,
  onSelectFreq,
  onToggleWeekday,
  options,
}: RecurrenceCustomEditorProps) {
  const [unitMenuOpen, setUnitMenuOpen] = useState(false);
  const hasRule = options !== null;

  return (
    <div className="space-y-3 border-t border-border/40 px-3 py-3">
      <div className="flex items-center gap-1.5 text-xs text-foreground/80">
        <span>Every</span>
        <input
          aria-label="Recurrence interval"
          className="w-8 rounded border border-border/60 bg-transparent py-0.5 text-center text-xs text-foreground transition-colors outline-none focus:border-primary/60"
          inputMode="numeric"
          onBlur={onIntervalCommit}
          onChange={(event) => onIntervalChange(event.target.value.replace(/\D/g, "").slice(0, 3))}
          onFocus={onIntervalFocus}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              onIntervalCommit();
              event.currentTarget.blur();
            }
            if (event.key === "Escape") {
              onIntervalCancel();
              event.currentTarget.blur();
            }
          }}
          value={intervalDisplay}
        />

        <Popover onOpenChange={setUnitMenuOpen} open={unitMenuOpen}>
          <PopoverTrigger asChild>
            <button
              className="inline-flex items-center gap-1 rounded border border-border/60 px-1.5 py-0.5 text-xs text-foreground transition-colors hover:border-primary/60 focus:outline-none"
              type="button"
            >
              <span>
                {options
                  ? options.interval === 1
                    ? FREQ_UNIT_LABELS[options.freq].singular
                    : FREQ_UNIT_LABELS[options.freq].plural
                  : "Week"}
              </span>
              <ChevronDown aria-hidden="true" size={10} />
            </button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-[120px] p-1">
            {(["DAILY", "WEEKLY", "MONTHLY", "YEARLY"] as RecurrenceFreq[]).map((freq) => {
              const isActive = options?.freq === freq;
              return (
                <button
                  className={cn(
                    "flex w-full items-center justify-between rounded px-2 py-1 text-left text-xs transition-colors",
                    isActive
                      ? "text-primary"
                      : "text-foreground/75 hover:bg-accent hover:text-foreground"
                  )}
                  key={freq}
                  onClick={() => {
                    onSelectFreq(freq);
                    setUnitMenuOpen(false);
                  }}
                  type="button"
                >
                  <span>
                    {options?.interval === 1 || !options
                      ? FREQ_UNIT_LABELS[freq].singular
                      : FREQ_UNIT_LABELS[freq].plural}
                  </span>
                  {isActive && <Check aria-hidden="true" size={11} strokeWidth={2.5} />}
                </button>
              );
            })}
          </PopoverContent>
        </Popover>
      </div>

      {hasRule && options.freq === "WEEKLY" && (
        <div className="flex gap-1">
          {WEEKDAYS.map(({ full, short, value }) => {
            const isActive = options.byweekday?.includes(value) ?? false;
            return (
              <button
                aria-label={full}
                aria-pressed={isActive}
                className={cn(
                  "h-6 w-6 rounded-full text-xs transition-colors",
                  isActive
                    ? "bg-primary/20 font-medium text-primary"
                    : "text-foreground/50 hover:bg-accent hover:text-foreground"
                )}
                key={value}
                onClick={() => onToggleWeekday(value)}
                type="button"
              >
                {short}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
