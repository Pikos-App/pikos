// DateTimePicker — controlled date+time picker used by DateSchedulePopover and QuickAddDialog.
//
// Pure UI component: no context, no side effects, no business knowledge.
// Renders a trigger button that opens a Popover with calendar + time slots + optional duration.
//
// Layout: two-column (calendar left · time slot list right) + optional duration footer.
// UX: all changes apply immediately via onChange — no internal uncommitted state.

import { parseLocalISO } from "@pikos/core";
import {
  addDays,
  addHours,
  format,
  getHours,
  getMinutes,
  isToday,
  isTomorrow,
  startOfDay,
} from "date-fns";
import { Calendar, ChevronLeft, ChevronRight, Pencil } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { useAppSettings } from "@/shared/context/AppSettingsContext";

// ── ISO formatters ────────────────────────────────────────────────────────────

function toISODateOnly(date: Date): string {
  return format(date, "yyyy-MM-dd");
}

function toISODateTime(date: Date, hour24: number, minute: number): string {
  const base = format(date, "yyyy-MM-dd");
  const hourStr = String(hour24).padStart(2, "0");
  const minuteStr = String(minute).padStart(2, "0");
  return `${base}T${hourStr}:${minuteStr}:00`;
}

// ── Time formatting helpers ───────────────────────────────────────────────────

function formatTimeOfDay(hour24: number, minute: number): string {
  const displayHour = hour24 % 12 || 12;
  const minuteStr = String(minute).padStart(2, "0");
  const period = hour24 >= 12 ? "PM" : "AM";
  return `${displayHour}:${minuteStr} ${period}`;
}

function formatTimeCompact(hour24: number, minute: number): string {
  const displayHour = hour24 % 12 || 12;
  const minuteStr = String(minute).padStart(2, "0");
  const period = hour24 >= 12 ? "pm" : "am";
  return `${displayHour}:${minuteStr}${period}`;
}

function formatDurationLabel(totalMinutes: number): string {
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${totalMinutes}m`;
  return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
}

function computeEndTimeLabel(hour24: number, minute: number, durationMinutes: number): string {
  const totalMinutes = hour24 * 60 + minute + durationMinutes;
  return formatTimeOfDay(Math.floor(totalMinutes / 60) % 24, totalMinutes % 60);
}

// ── Trigger label ─────────────────────────────────────────────────────────────

function formatTriggerLabel(
  iso: string,
  endIso: string | null | undefined,
  isDone: boolean
): { label: string; isPast: boolean; isDueSoon: boolean } {
  const date = parseLocalISO(iso);
  const now = new Date();
  const isAllDay = iso.length === 10;
  const durationMinutes =
    !isAllDay && endIso && endIso.length > 10
      ? Math.round((parseLocalISO(endIso).getTime() - parseLocalISO(iso).getTime()) / 60000)
      : null;
  const durationSuffix =
    durationMinutes && durationMinutes > 0 ? ` · ${formatDurationLabel(durationMinutes)}` : "";

  const isPast = isAllDay ? date < startOfDay(now) : date < now;
  // Due soon: not past, within next 48 hours, not done
  const dueSoon = !isPast && !isDone && date < addHours(now, 48);

  if (isToday(date)) {
    if (isAllDay) return { isDueSoon: dueSoon, isPast: false, label: `Today${durationSuffix}` };
    return {
      isDueSoon: dueSoon,
      isPast: isPast && !isDone,
      label: `Today ${formatTimeCompact(getHours(date), getMinutes(date))}${durationSuffix}`,
    };
  }
  if (isTomorrow(date)) {
    if (isAllDay) return { isDueSoon: dueSoon, isPast: false, label: `Tomorrow${durationSuffix}` };
    return {
      isDueSoon: dueSoon,
      isPast: false,
      label: `Tomorrow ${formatTimeCompact(getHours(date), getMinutes(date))}${durationSuffix}`,
    };
  }
  const dateStr = format(date, "MMM d");
  if (!isAllDay) {
    return {
      isDueSoon: dueSoon,
      isPast: isPast && !isDone,
      label: `${dateStr} ${formatTimeCompact(getHours(date), getMinutes(date))}${durationSuffix}`,
    };
  }
  return { isDueSoon: dueSoon, isPast: isPast && !isDone, label: `${dateStr}${durationSuffix}` };
}

// ── Time slots ────────────────────────────────────────────────────────────────
// 96 slots: 12:00 AM → 11:45 PM in 15-minute increments.

interface TimeSlot {
  idx: number;
  hour24: number;
  minute: number;
  label: string;
}

const TIME_SLOTS: TimeSlot[] = Array.from({ length: 96 }, (_, idx) => {
  const hour24 = Math.floor(idx / 4);
  const minute = (idx % 4) * 15;
  return { hour24, idx, label: formatTimeOfDay(hour24, minute), minute };
});

// ── Duration presets ──────────────────────────────────────────────────────────

const DURATION_PRESETS = [
  { label: "15m", minutes: 15 },
  { label: "30m", minutes: 30 },
  { label: "1h", minutes: 60 },
  { label: "1.5h", minutes: 90 },
  { label: "2h", minutes: 120 },
] as const;

// ── MiniCalendar ──────────────────────────────────────────────────────────────

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

// Fixed height: nav (24px + 8px mb) + day headers (~16px) + 6 rows × 26px = 204px.
const CAL_HEIGHT = 48 + 6 * 26;

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

// ── DateTimePicker ────────────────────────────────────────────────────────────

interface DateTimePickerProps {
  /** ISO 8601 date (date-only or datetime) or null (no schedule). */
  value: string | null;
  /** Called with an ISO string when a date/time is selected, or null to clear. */
  onChange: (iso: string | null) => void;
  /** End ISO 8601 datetime — duration is calculated as endValue − value. Optional — hides duration section if absent. */
  endValue?: string | null;
  /** Called when user picks a duration preset (sets the end ISO). Optional — hides duration section if absent. */
  onEndChange?: (iso: string | null) => void;
  /** When true, past dates are not highlighted red. */
  isDone?: boolean;
}

export function DateTimePicker({
  endValue,
  isDone = false,
  onChange,
  onEndChange,
  value,
}: DateTimePickerProps) {
  const { weekStart } = useAppSettings();
  const [open, setOpen] = useState(false);

  // ── Calendar navigation state ────────────────────────────────────────────────
  // viewYear/viewMonth control which month is visible; reset to value's month on open.
  // selectedDate/selectedTime are derived from `value` (no state mirrors).

  const [viewYear, setViewYear] = useState(() => new Date().getFullYear());
  const [viewMonth, setViewMonth] = useState(() => new Date().getMonth());

  // ── Custom time entry (virtual slot for non-15-min times) ────────────────────

  const [customTimeEntry, setCustomTimeEntry] = useState<{
    hour24: number;
    minute: number;
    label: string;
  } | null>(null);

  // ── Keyboard navigation index into displayed slots ───────────────────────────

  const [focusedSlotIdx, setFocusedSlotIdx] = useState<number | null>(null);

  // ── Text inputs ──────────────────────────────────────────────────────────────

  const [customTimeStr, setCustomTimeStr] = useState("");
  const [customDurationActive, setCustomDurationActive] = useState(false);
  const [customDurationStr, setCustomDurationStr] = useState("");

  const timeListRef = useRef<HTMLDivElement>(null);

  // ── Derived values from `value` prop ─────────────────────────────────────────

  const parsedValue = value ? parseLocalISO(value) : null;
  const selectedDate = parsedValue
    ? new Date(parsedValue.getFullYear(), parsedValue.getMonth(), parsedValue.getDate())
    : null;
  const selectedTime =
    value && value.length > 10 && parsedValue
      ? { hour24: getHours(parsedValue), minute: getMinutes(parsedValue) }
      : null;

  // ── Open/close handler ───────────────────────────────────────────────────────
  // Reset navigation state and clear transient UI state when popover opens.

  function handleOpenChange(next: boolean) {
    if (next) {
      const refDate = parsedValue ?? new Date();
      setViewYear(refDate.getFullYear());
      setViewMonth(refDate.getMonth());
      setCustomTimeEntry(null);
      setFocusedSlotIdx(null);
      setCustomTimeStr("");
      setCustomDurationActive(false);
      setCustomDurationStr("");
    } else {
      setFocusedSlotIdx(null);
      setCustomDurationActive(false);
    }
    setOpen(next);
  }

  // ── Displayed slots: preset list + optional custom entry ─────────────────────

  type DisplaySlot = TimeSlot & { isCustom?: true };

  const displayedSlots: DisplaySlot[] = (() => {
    if (!customTimeEntry) return TIME_SLOTS;
    const customMinutes = customTimeEntry.hour24 * 60 + customTimeEntry.minute;
    const insertAt = TIME_SLOTS.findIndex((slot) => slot.hour24 * 60 + slot.minute > customMinutes);
    const entry: DisplaySlot = { idx: -1, ...customTimeEntry, isCustom: true };
    if (insertAt === -1) return [...TIME_SLOTS, entry];
    return [...TIME_SLOTS.slice(0, insertAt), entry, ...TIME_SLOTS.slice(insertAt)];
  })();

  // ── Scroll helper ────────────────────────────────────────────────────────────

  function scrollTimeListToSlot(hour24: number, minute: number) {
    setTimeout(() => {
      const el = timeListRef.current?.querySelector<HTMLElement>(
        `[data-h="${hour24}"][data-m="${minute}"]`
      );
      if (!el || !timeListRef.current) return;
      const list = timeListRef.current;
      list.scrollTop = el.offsetTop - list.clientHeight / 2 + el.clientHeight / 2;
    }, 0);
  }

  // ── Scroll to selected/default time when popover opens ──────────────────────
  // DOM-only effect: no setState calls.

  const scrollTargetHour = selectedTime?.hour24 ?? 8;
  const scrollTargetMinute = selectedTime?.minute ?? 0;

  useEffect(() => {
    if (!open) return;
    const id = setTimeout(() => {
      const el = timeListRef.current?.querySelector<HTMLElement>(
        `[data-h="${scrollTargetHour}"][data-m="${scrollTargetMinute}"]`
      );
      if (!el || !timeListRef.current) return;
      const list = timeListRef.current;
      list.scrollTop = el.offsetTop - list.clientHeight / 2 + el.clientHeight / 2;
    }, 0);
    return () => clearTimeout(id);
  }, [open, scrollTargetHour, scrollTargetMinute]);

  // ── Calendar actions ─────────────────────────────────────────────────────────

  function selectDate(date: Date) {
    setViewYear(date.getFullYear());
    setViewMonth(date.getMonth());
    if (selectedTime) {
      onChange(toISODateTime(date, selectedTime.hour24, selectedTime.minute));
    } else {
      onChange(toISODateOnly(date));
    }
  }

  function quickPick(daysOffset: number) {
    const date = startOfDay(addDays(new Date(), daysOffset));
    if (selectedTime) {
      onChange(toISODateTime(date, selectedTime.hour24, selectedTime.minute));
    } else {
      onChange(toISODateOnly(date));
    }
  }

  // ── Time actions ──────────────────────────────────────────────────────────────

  function applyTime(hour24: number, minute: number, keepCustomEntry = false) {
    setFocusedSlotIdx(null);
    if (!keepCustomEntry) setCustomTimeEntry(null);
    const date = selectedDate ?? startOfDay(new Date());
    onChange(toISODateTime(date, hour24, minute));
  }

  function handleSlotClick(slot: DisplaySlot) {
    const isCustomSlot =
      slot.isCustom === true &&
      customTimeEntry?.hour24 === slot.hour24 &&
      customTimeEntry?.minute === slot.minute;
    applyTime(slot.hour24, slot.minute, isCustomSlot);
  }

  function clearTime() {
    setCustomTimeEntry(null);
    if (selectedDate) onChange(toISODateOnly(selectedDate));
  }

  function applyCustomTimeInput() {
    if (!customTimeStr.trim()) return;
    const parsed = parseCustomTimeStr(customTimeStr);
    if (!parsed) {
      setCustomTimeStr("");
      return;
    }
    const { hour24, minute } = parsed;
    const presetMatch = TIME_SLOTS.find((slot) => slot.hour24 === hour24 && slot.minute === minute);
    if (presetMatch) {
      setCustomTimeEntry(null);
      applyTime(hour24, minute, false);
      scrollTimeListToSlot(hour24, minute);
    } else {
      const label = formatTimeOfDay(hour24, minute);
      setCustomTimeEntry({ hour24, label, minute });
      const date = selectedDate ?? startOfDay(new Date());
      onChange(toISODateTime(date, hour24, minute));
      scrollTimeListToSlot(hour24, minute);
    }
    setCustomTimeStr("");
  }

  function handleTimeListKeyDown(event: React.KeyboardEvent) {
    const maxIdx = displayedSlots.length - 1;
    const selectedSlotIdx = selectedTime
      ? displayedSlots.findIndex(
          (slot) => slot.hour24 === selectedTime.hour24 && slot.minute === selectedTime.minute
        )
      : -1;

    if (event.key === "ArrowDown") {
      event.preventDefault();
      const fromIdx = focusedSlotIdx ?? (selectedSlotIdx !== -1 ? selectedSlotIdx : 63);
      const nextIdx = Math.min(fromIdx + 1, maxIdx);
      setFocusedSlotIdx(nextIdx);
      const slot = displayedSlots[nextIdx];
      if (slot) scrollTimeListToSlot(slot.hour24, slot.minute);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      const fromIdx = focusedSlotIdx ?? (selectedSlotIdx !== -1 ? selectedSlotIdx : 65);
      const nextIdx = Math.max(fromIdx - 1, 0);
      setFocusedSlotIdx(nextIdx);
      const slot = displayedSlots[nextIdx];
      if (slot) scrollTimeListToSlot(slot.hour24, slot.minute);
    } else if (event.key === "Enter" && focusedSlotIdx !== null) {
      event.preventDefault();
      const slot = displayedSlots[focusedSlotIdx];
      if (slot) handleSlotClick(slot);
    }
  }

  // ── Duration actions ──────────────────────────────────────────────────────────

  function selectDuration(minutes: number | null) {
    if (!onEndChange) return;
    if (minutes === null) {
      onEndChange(null);
      return;
    }
    const startDate = value ? parseLocalISO(value) : null;
    if (!startDate || value!.length <= 10) return; // no timed start
    const endDate = new Date(startDate.getTime() + minutes * 60000);
    onEndChange(toISODateTime(endDate, endDate.getHours(), endDate.getMinutes()));
  }

  function applyCustomDuration() {
    const trimmed = customDurationStr.trim();
    if (trimmed === "") {
      selectDuration(null);
    } else {
      const parsed = parseCustomDurationStr(trimmed);
      if (parsed !== null) selectDuration(parsed);
    }
    setCustomDurationActive(false);
    setCustomDurationStr("");
  }

  // ── Clear all ─────────────────────────────────────────────────────────────────

  function handleClearAll() {
    onChange(null);
    setOpen(false);
  }

  // ── Computed ──────────────────────────────────────────────────────────────────

  const hasDate = value !== null;
  const {
    isDueSoon,
    isPast,
    label: triggerLabel,
  } = value
    ? formatTriggerLabel(value, endValue, isDone)
    : { isDueSoon: false, isPast: false, label: "Schedule" };

  // Duration in minutes derived from start/end — only meaningful for timed events.
  const durationMinutes =
    value && value.length > 10 && endValue && endValue.length > 10
      ? Math.round((parseLocalISO(endValue).getTime() - parseLocalISO(value).getTime()) / 60000)
      : null;

  const endTimeLabel =
    selectedTime !== null && durationMinutes != null && durationMinutes > 0
      ? computeEndTimeLabel(selectedTime.hour24, selectedTime.minute, durationMinutes)
      : null;

  const isCustomDuration =
    durationMinutes != null &&
    !DURATION_PRESETS.some((preset) => preset.minutes === durationMinutes);

  const showDurationSection = onEndChange !== undefined && selectedTime !== null;

  // ── Render ────────────────────────────────────────────────────────────────────

  return (
    <Popover onOpenChange={handleOpenChange} open={open}>
      <PopoverTrigger asChild>
        <button
          aria-label={hasDate ? `Scheduled: ${triggerLabel}` : "Set schedule"}
          className={cn(
            "inline-flex shrink-0 items-center gap-1 rounded text-sm whitespace-nowrap transition-colors focus:outline-none",
            isPast
              ? "text-status-overdue hover:text-status-overdue/80"
              : isDueSoon
                ? "text-status-due-soon hover:text-status-due-soon/80"
                : hasDate
                  ? "text-muted-foreground hover:text-foreground"
                  : "text-muted-foreground/60 hover:text-muted-foreground"
          )}
        >
          <Calendar aria-hidden="true" size={13} />
          <span>{triggerLabel}</span>
        </button>
      </PopoverTrigger>

      <PopoverContent align="start" className="w-[380px] p-0">
        <div className="p-3">
          {/* Quick picks */}
          <div className="flex w-full items-start justify-between">
            <div className="mb-3 flex items-center gap-0.5 text-xs">
              {(
                [
                  ["Today", 0],
                  ["Tomorrow", 1],
                  ["Next week", 7],
                ] as const
              ).map(([label, offset], idx) => {
                const pickDate = startOfDay(addDays(new Date(), offset));
                const isActive =
                  selectedDate !== null &&
                  selectedDate.getFullYear() === pickDate.getFullYear() &&
                  selectedDate.getMonth() === pickDate.getMonth() &&
                  selectedDate.getDate() === pickDate.getDate();
                return (
                  <span className="flex items-center" key={label}>
                    {idx > 0 && (
                      <span aria-hidden="true" className="mx-1.5 text-muted-foreground/25">
                        ·
                      </span>
                    )}
                    <button
                      className={cn(
                        "transition-colors",
                        isActive
                          ? "font-medium text-primary"
                          : "text-foreground/55 hover:text-foreground"
                      )}
                      onClick={() => quickPick(offset)}
                    >
                      {label}
                    </button>
                  </span>
                );
              })}
            </div>
            {hasDate && (
              <button
                className="text-xs text-foreground/55 hover:text-foreground"
                onClick={handleClearAll}
              >
                Clear
              </button>
            )}
          </div>

          {/* Two-column: calendar + time slots */}
          <div className="flex items-start gap-3" style={{ height: CAL_HEIGHT }}>
            <div className="min-w-0 flex-1">
              <MiniCalendar
                month={viewMonth}
                onNext={() => {
                  if (viewMonth === 11) {
                    setViewMonth(0);
                    setViewYear((year) => year + 1);
                  } else {
                    setViewMonth((month) => month + 1);
                  }
                }}
                onPrev={() => {
                  if (viewMonth === 0) {
                    setViewMonth(11);
                    setViewYear((year) => year - 1);
                  } else {
                    setViewMonth((month) => month - 1);
                  }
                }}
                onSelect={selectDate}
                selectedDate={selectedDate}
                weekStartsOn={weekStart}
                year={viewYear}
              />
            </div>

            {/* Time panel */}
            <div
              className="flex w-32 shrink-0 flex-col gap-1.5 border-l border-border/40 pl-3"
              style={{ height: CAL_HEIGHT }}
            >
              <button
                aria-label="All day — no specific time"
                className={cn(
                  "self-start text-xs transition-colors",
                  selectedTime === null
                    ? "font-medium text-primary"
                    : "text-foreground/40 hover:text-foreground"
                )}
                onClick={clearTime}
              >
                All day
              </button>

              <div
                aria-label="Select start time"
                className="min-h-0 flex-1 overflow-y-auto rounded-sm focus:outline-none [&::-webkit-scrollbar]:hidden"
                onBlur={(event) => {
                  if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                    setFocusedSlotIdx(null);
                  }
                }}
                onFocus={() => {
                  if (focusedSlotIdx === null) {
                    const selIdx = selectedTime
                      ? displayedSlots.findIndex(
                          (slot) =>
                            slot.hour24 === selectedTime.hour24 &&
                            slot.minute === selectedTime.minute
                        )
                      : -1;
                    setFocusedSlotIdx(selIdx !== -1 ? selIdx : 32);
                  }
                }}
                onKeyDown={handleTimeListKeyDown}
                ref={timeListRef}
                role="listbox"
                tabIndex={0}
              >
                {displayedSlots.map((slot, displayIdx) => {
                  const isSelected =
                    selectedTime !== null &&
                    selectedTime.hour24 === slot.hour24 &&
                    selectedTime.minute === slot.minute;
                  const isFocused = focusedSlotIdx === displayIdx;
                  return (
                    <button
                      aria-selected={isSelected}
                      className={cn(
                        "flex w-full rounded px-1.5 py-[3px] text-left text-xs transition-colors",
                        isSelected
                          ? "font-medium text-primary"
                          : isFocused
                            ? "bg-accent text-foreground"
                            : "text-foreground/55 hover:text-foreground"
                      )}
                      data-h={slot.hour24}
                      data-m={slot.minute}
                      key={slot.isCustom ? `custom-${slot.hour24}-${slot.minute}` : slot.idx}
                      onClick={() => handleSlotClick(slot)}
                      role="option"
                      tabIndex={-1}
                    >
                      {slot.label}
                    </button>
                  );
                })}
              </div>

              <input
                autoCapitalize="off"
                autoComplete="off"
                autoCorrect="off"
                className="w-full cursor-text border-none bg-transparent px-0.5 py-1 text-xs text-foreground/80 outline-none placeholder:text-muted-foreground/60"
                onBlur={applyCustomTimeInput}
                onChange={(event) => setCustomTimeStr(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    applyCustomTimeInput();
                  }
                  if (event.key === "Escape") setCustomTimeStr("");
                }}
                placeholder="or type a time…"
                type="text"
                value={customTimeStr}
              />
            </div>
          </div>
        </div>

        {/* Duration section — only shown when onDurationChange is provided and time is set */}
        {showDurationSection && (
          <div className="border-t border-border/60 px-3 py-2.5">
            <div className="flex flex-wrap items-center gap-1.5">
              {DURATION_PRESETS.map(({ label, minutes }) => {
                const isActive = durationMinutes === minutes;
                return (
                  <button
                    aria-label={`Duration: ${label}`}
                    aria-pressed={isActive}
                    className={cn(
                      "rounded px-1.5 py-0.5 text-xs transition-colors",
                      isActive
                        ? "font-medium text-primary"
                        : "text-foreground/55 hover:text-foreground"
                    )}
                    key={minutes}
                    onClick={() => selectDuration(isActive ? null : minutes)}
                  >
                    {label}
                  </button>
                );
              })}

              <div className="flex w-20 shrink-0 items-center whitespace-nowrap">
                {customDurationActive ? (
                  <input
                    autoCapitalize="off"
                    autoComplete="off"
                    autoCorrect="off"
                    autoFocus
                    className="h-6 w-full cursor-text border-none bg-transparent px-0.5 text-xs text-foreground/80 outline-none placeholder:text-muted-foreground/60"
                    inputMode="text"
                    onBlur={applyCustomDuration}
                    onChange={(event) => setCustomDurationStr(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        applyCustomDuration();
                      }
                      if (event.key === "Escape") {
                        setCustomDurationActive(false);
                        setCustomDurationStr("");
                      }
                    }}
                    placeholder="1h 30m"
                    type="text"
                    value={customDurationStr}
                  />
                ) : (
                  <button
                    aria-label={
                      isCustomDuration && durationMinutes != null
                        ? `Edit custom duration (${formatDurationLabel(durationMinutes)})`
                        : "Set custom duration"
                    }
                    aria-pressed={isCustomDuration}
                    className={cn(
                      "group inline-flex h-6 w-full items-center gap-1 rounded px-1.5 text-xs transition-colors",
                      isCustomDuration
                        ? "font-medium text-primary"
                        : "text-foreground/55 hover:text-foreground"
                    )}
                    onClick={() => {
                      setCustomDurationStr(
                        durationMinutes != null && isCustomDuration ? String(durationMinutes) : ""
                      );
                      setCustomDurationActive(true);
                    }}
                  >
                    <span>
                      {isCustomDuration && durationMinutes != null
                        ? formatDurationLabel(durationMinutes)
                        : "Custom"}
                    </span>
                    <Pencil
                      aria-hidden="true"
                      className="text-muted-foreground/60 transition-opacity group-hover:text-foreground"
                      size={10}
                    />
                  </button>
                )}
              </div>

              {endTimeLabel !== null && selectedTime !== null && (
                <p className="ml-auto text-xs text-foreground/60">
                  {formatTimeOfDay(selectedTime.hour24, selectedTime.minute)}
                  <span className="mx-1 text-foreground/30">→</span>
                  {endTimeLabel}
                </p>
              )}
            </div>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

// ── Custom time string parser ─────────────────────────────────────────────────

function parseCustomTimeStr(input: string): { hour24: number; minute: number } | null {
  const normalized = input.trim().replace(/\s+/g, "");
  const match = normalized.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i);
  if (!match) return null;

  let hours = parseInt(match[1] ?? "0");
  const minutes = match[2] !== undefined ? parseInt(match[2]) : 0;
  const period = match[3]?.toLowerCase();

  if (minutes < 0 || minutes > 59) return null;

  if (period === undefined) {
    if (hours < 0 || hours > 23) return null;
    return { hour24: hours, minute: minutes };
  }
  if (hours < 1 || hours > 12) return null;
  if (period === "pm" && hours !== 12) hours += 12;
  if (period === "am" && hours === 12) hours = 0;
  return { hour24: hours, minute: minutes };
}

// ── Custom duration string parser ─────────────────────────────────────────────
// Accepts: "90", "90m", "1h", "1.5h", "1h 30m", "1h30m". Plain numbers → minutes.

function parseCustomDurationStr(input: string): number | null {
  const normalized = input.trim().toLowerCase().replace(/\s+/g, "");
  if (!normalized) return null;

  if (/^\d+(\.\d+)?$/.test(normalized)) {
    const n = parseFloat(normalized);
    return n > 0 ? Math.round(n) : null;
  }

  const match = normalized.match(/^(?:(\d+(?:\.\d+)?)h)?(?:(\d+)m)?$/);
  if (!match || (match[1] === undefined && match[2] === undefined)) return null;

  const hours = match[1] !== undefined ? parseFloat(match[1]) : 0;
  const minutes = match[2] !== undefined ? parseInt(match[2]) : 0;
  const total = Math.round(hours * 60 + minutes);
  return total > 0 ? total : null;
}
