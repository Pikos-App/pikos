// DateSchedulePopover — scheduling surface for the metadata byline.
//
// Layout: two-column (calendar left · time slot list right) + full-width footer
// (duration chips + computed end time + clear).
//
// UX contract:
//   • All changes apply immediately — no Save button.
//   • Calendar click selects the date. Time list click sets time; "All day" clears it.
//   • Duration chips toggle; Custom opens an inline minute input.
//   • Arrow keys navigate the time list; Enter confirms the focused slot.
//   • Custom time input: type any time (e.g. "10:01am") → injected into the list
//     at the correct position; cleared from the list when another slot is picked.
//   • Escape / click-outside closes. No focus trap needed (Radix handles it).

import { useEffect, useRef, useState } from "react";
import { Calendar, ChevronLeft, ChevronRight } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { useWorkspace } from "@/shared/context/WorkspaceContext";
import type { Page } from "@pikos/core";

// ── Time slot data ────────────────────────────────────────────────────────────
// 96 slots: 12:00 AM → 11:45 PM in 15-min increments.

interface TimeSlot {
  idx: number;
  hour24: number;
  minute: number;
  label: string; // "8:00 AM"
}

function fmt12(hour24: number, minute: number): string {
  const ap = hour24 >= 12 ? "PM" : "AM";
  const h = hour24 % 12 || 12;
  const m = String(minute).padStart(2, "0");
  return `${h}:${m} ${ap}`;
}

const TIME_SLOTS: TimeSlot[] = Array.from({ length: 96 }, (_, i) => ({
  idx: i,
  hour24: Math.floor(i / 4),
  minute: (i % 4) * 15,
  label: fmt12(Math.floor(i / 4), (i % 4) * 15),
}));

// ── Duration presets ──────────────────────────────────────────────────────────

const DURATION_PRESETS = [
  { label: "15m", minutes: 15 },
  { label: "30m", minutes: 30 },
  { label: "1h", minutes: 60 },
  { label: "1.5h", minutes: 90 },
  { label: "2h", minutes: 120 },
] as const;

function fmtDuration(mins: number): string {
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

function computeEndLabel(hour24: number, minute: number, durationMinutes: number): string {
  const total = hour24 * 60 + minute + durationMinutes;
  return fmt12(Math.floor(total / 60) % 24, total % 60);
}

// ── ISO helpers ───────────────────────────────────────────────────────────────

function toISOAllDay(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function toISOTimed24(date: Date, hour24: number, minute: number): string {
  const y = date.getFullYear();
  const mo = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  const h = String(hour24).padStart(2, "0");
  const mi = String(minute).padStart(2, "0");
  return `${y}-${mo}-${d}T${h}:${mi}:00`;
}

function parseISODate(iso: string): Date {
  // Always parse as local, never UTC
  const tIdx = iso.indexOf("T");
  if (tIdx === -1) {
    return new Date(
      parseInt(iso.slice(0, 4)),
      parseInt(iso.slice(5, 7)) - 1,
      parseInt(iso.slice(8, 10))
    );
  }
  const dp = iso.slice(0, tIdx);
  const tp = iso.slice(tIdx + 1);
  return new Date(
    parseInt(dp.slice(0, 4)),
    parseInt(dp.slice(5, 7)) - 1,
    parseInt(dp.slice(8, 10)),
    parseInt(tp.slice(0, 2)),
    parseInt(tp.slice(3, 5)),
    0
  );
}

// ── Custom time parsing ───────────────────────────────────────────────────────

function parseCustomTime(input: string): { hour24: number; minute: number } | null {
  const s = input.trim().replace(/\s+/g, "");
  const match = s.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i);
  if (!match) return null;

  let hour = parseInt(match[1] ?? "0");
  const minute = match[2] !== undefined ? parseInt(match[2]) : 0;
  const period = match[3]?.toLowerCase();

  if (minute < 0 || minute > 59) return null;

  if (period === undefined) {
    if (hour < 0 || hour > 23) return null;
    return { hour24: hour, minute };
  }
  if (hour < 1 || hour > 12) return null;
  if (period === "pm" && hour !== 12) hour += 12;
  if (period === "am" && hour === 12) hour = 0;
  return { hour24: hour, minute };
}

// ── Trigger label ─────────────────────────────────────────────────────────────

function fmtTrigger(
  iso: string,
  durationMinutes: number | null | undefined,
  isDone: boolean
): { label: string; isPast: boolean } {
  const date = parseISODate(iso);
  const isAllDay = iso.length === 10;

  const now = new Date();
  const todayMid = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const tomMid = new Date(todayMid.getTime() + 86_400_000);
  const isToday = date >= todayMid && date < tomMid;
  const isTomorrow = date >= tomMid && date < new Date(tomMid.getTime() + 86_400_000);
  const isPast = isAllDay ? date < todayMid : date < now;

  const durationSuffix = durationMinutes ? ` · ${fmtDuration(durationMinutes)}` : "";

  if (isToday && !isAllDay) {
    const h = date.getHours() % 12 || 12;
    const m = date.getMinutes().toString().padStart(2, "0");
    const ap = date.getHours() >= 12 ? "pm" : "am";
    return {
      label: `Today ${h}:${m}${ap}${durationSuffix}`,
      isPast: date < now && !isDone,
    };
  }
  if (isToday) return { label: `Today${durationSuffix}`, isPast: false };
  if (isTomorrow) return { label: `Tomorrow${durationSuffix}`, isPast: false };

  const dateStr = date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  if (!isAllDay) {
    const h = date.getHours() % 12 || 12;
    const m = date.getMinutes().toString().padStart(2, "0");
    const ap = date.getHours() >= 12 ? "pm" : "am";
    return { label: `${dateStr} ${h}:${m}${ap}${durationSuffix}`, isPast: isPast && !isDone };
  }
  return { label: `${dateStr}${durationSuffix}`, isPast: isPast && !isDone };
}

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
const DAY_ABBRS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];

function MiniCalendar({
  year,
  month,
  selectedDate,
  onSelect,
  onPrev,
  onNext,
}: {
  year: number;
  month: number;
  selectedDate: Date | null;
  onSelect: (date: Date) => void;
  onPrev: () => void;
  onNext: () => void;
}) {
  const today = new Date();
  const tD = today.getDate();
  const tM = today.getMonth();
  const tY = today.getFullYear();

  const firstDOW = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();

  const cells: Array<number | null> = [];
  for (let i = 0; i < firstDOW; i++) cells.push(null);
  for (let i = 1; i <= daysInMonth; i++) cells.push(i);
  // Pad to a complete final row only — no extra blank rows.
  while (cells.length % 7 !== 0) cells.push(null);

  return (
    <div className="select-none">
      {/* Month nav — title left, arrows right */}
      <div className="mb-2 flex items-center">
        <span className="flex-1 text-sm font-semibold tracking-tight">
          {MONTH_NAMES[month]} {year}
        </span>
        <button
          onClick={onPrev}
          className="flex h-6 w-6 cursor-pointer items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
          aria-label="Previous month"
        >
          <ChevronLeft size={14} />
        </button>
        <button
          onClick={onNext}
          className="ml-0.5 flex h-6 w-6 cursor-pointer items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
          aria-label="Next month"
        >
          <ChevronRight size={14} />
        </button>
      </div>

      {/* Day-of-week headers */}
      <div className="grid grid-cols-7">
        {DAY_ABBRS.map((d) => (
          <div
            key={d}
            className="pb-1 text-center text-[10px] font-medium tracking-wide text-muted-foreground/60"
          >
            {d}
          </div>
        ))}
      </div>

      {/* Day cells — full-column buttons, inner circle for highlight */}
      <div className="grid grid-cols-7">
        {cells.map((day, i) => {
          if (day === null) return <div key={`b${i}`} className="h-8" />;

          const isToday = year === tY && month === tM && day === tD;
          const isSelected =
            selectedDate !== null &&
            selectedDate.getFullYear() === year &&
            selectedDate.getMonth() === month &&
            selectedDate.getDate() === day;

          return (
            <button
              key={day}
              onClick={() => onSelect(new Date(year, month, day))}
              className="flex h-8 w-full cursor-pointer items-center justify-center focus:outline-none"
              aria-label={`${MONTH_NAMES[month]} ${day}, ${year}`}
              aria-pressed={isSelected}
            >
              <span
                className={cn(
                  "relative flex h-7 w-7 items-center justify-center rounded-full text-sm transition-colors",
                  isSelected
                    ? "font-medium text-primary"
                    : isToday
                      ? "text-foreground hover:text-foreground"
                      : "text-foreground/75 hover:text-foreground"
                )}
              >
                {day}
                {/* Dot under today when not selected */}
                {isToday && !isSelected && (
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

// ── Calendar height ───────────────────────────────────────────────────────────
// Fixed at 6 rows (the maximum any month can occupy) so the popover never
// resizes when navigating between months.
// month-nav (24px + 8px mb) + day-headers (~16px) + 6 rows × 28px = 240px.

const CAL_HEIGHT = 48 + 6 * 26;

// ── DateSchedulePopover ───────────────────────────────────────────────────────

export function DateSchedulePopover({ page }: { page: Page }) {
  const { scheduleOnce, clearSchedule, updatePage } = useWorkspace();
  const isDone = page.status === "done";

  const [open, setOpen] = useState(false);

  // ── Picker state ────────────────────────────────────────────────────────────

  const [viewYear, setViewYear] = useState(() => new Date().getFullYear());
  const [viewMonth, setViewMonth] = useState(() => new Date().getMonth());
  const [selectedDate, setSelectedDate] = useState<Date | null>(null);
  // null = all-day; otherwise the exact selected time
  const [selectedTime, setSelectedTime] = useState<{ hour24: number; minute: number } | null>(null);
  // Virtual slot injected into the list for non-15-min-boundary custom times.
  // Cleared when the user picks any preset slot.
  const [customTimeEntry, setCustomTimeEntry] = useState<{
    hour24: number;
    minute: number;
    label: string;
  } | null>(null);
  const [durationMinutes, setDurationMinutes] = useState<number | null>(null);

  // Time list keyboard navigation — index into displayedSlots
  const timeListRef = useRef<HTMLDivElement>(null);
  const [focusedTimeIdx, setFocusedTimeIdx] = useState<number | null>(null);

  // Stores the target time to scroll to when the popover opens.
  const scrollToOnOpenRef = useRef<{ hour24: number; minute: number }>({ hour24: 8, minute: 0 });

  // Custom time input (below the time list)
  const [customTimeStr, setCustomTimeStr] = useState("");

  // Custom duration
  const [customDurationActive, setCustomDurationActive] = useState(false);
  const [customDurationStr, setCustomDurationStr] = useState("");

  // ── Displayed slots ──────────────────────────────────────────────────────────
  // TIME_SLOTS (15-min presets) + optional custom entry inserted in order.

  type DisplaySlot = TimeSlot & { isCustom?: true };

  const displayedSlots: DisplaySlot[] = (() => {
    if (!customTimeEntry) return TIME_SLOTS;
    const mins = customTimeEntry.hour24 * 60 + customTimeEntry.minute;
    const insertAt = TIME_SLOTS.findIndex((s) => s.hour24 * 60 + s.minute > mins);
    const entry: DisplaySlot = { idx: -1, ...customTimeEntry, isCustom: true };
    if (insertAt === -1) return [...TIME_SLOTS, entry];
    return [...TIME_SLOTS.slice(0, insertAt), entry, ...TIME_SLOTS.slice(insertAt)];
  })();

  // ── Scroll helper ────────────────────────────────────────────────────────────

  function scrollToTime(hour24: number, minute: number) {
    setTimeout(() => {
      if (!timeListRef.current) return;
      const el = timeListRef.current.querySelector<HTMLElement>(
        `[data-h="${hour24}"][data-m="${minute}"]`
      );
      if (!el) return;
      const list = timeListRef.current;
      list.scrollTop = el.offsetTop - list.clientHeight / 2 + el.clientHeight / 2;
    }, 0);
  }

  // ── State initialisation ────────────────────────────────────────────────────

  function resetFromPage() {
    const iso = page.scheduledStart;
    let date: Date | null = null;
    let time: { hour24: number; minute: number } | null = null;
    let custom: { hour24: number; minute: number; label: string } | null = null;

    if (iso) {
      date = parseISODate(iso);
      if (iso.length > 10) {
        const h = date.getHours();
        const m = date.getMinutes();
        time = { hour24: h, minute: m };
        // Restore custom entry if the saved time is off the 15-min grid
        if (m % 15 !== 0) {
          custom = { hour24: h, minute: m, label: fmt12(h, m) };
        }
      }
    }

    setSelectedDate(date);
    setSelectedTime(time);
    setCustomTimeEntry(custom);
    setDurationMinutes(page.durationMinutes ?? null);
    setCustomTimeStr("");
    setCustomDurationActive(false);
    setCustomDurationStr("");
    setFocusedTimeIdx(null);

    scrollToOnOpenRef.current = time ?? { hour24: 8, minute: 0 };

    const ref = date ?? new Date();
    setViewYear(ref.getFullYear());
    setViewMonth(ref.getMonth());
  }

  function handleOpenChange(next: boolean) {
    if (next) resetFromPage();
    else {
      setFocusedTimeIdx(null);
      setCustomDurationActive(false);
    }
    setOpen(next);
  }

  // Scroll time list to selected slot (or 8:00 AM default) on open.
  useEffect(() => {
    if (!open) return;
    const { hour24, minute } = scrollToOnOpenRef.current;
    const id = setTimeout(() => {
      if (!timeListRef.current) return;
      const el = timeListRef.current.querySelector<HTMLElement>(
        `[data-h="${hour24}"][data-m="${minute}"]`
      );
      if (!el) return;
      const list = timeListRef.current;
      list.scrollTop = el.offsetTop - list.clientHeight / 2 + el.clientHeight / 2;
    }, 0);
    return () => clearTimeout(id);
  }, [open]);

  // ── Save helpers ────────────────────────────────────────────────────────────

  function saveSchedule(date: Date, time: { hour24: number; minute: number } | null) {
    if (time !== null) {
      void scheduleOnce(page.id, toISOTimed24(date, time.hour24, time.minute));
    } else {
      void scheduleOnce(page.id, toISOAllDay(date));
    }
  }

  function saveDuration(mins: number | null) {
    updatePage(page.id, { durationMinutes: mins });
  }

  // ── Calendar actions ────────────────────────────────────────────────────────

  function selectDate(date: Date) {
    setSelectedDate(date);
    setViewYear(date.getFullYear());
    setViewMonth(date.getMonth());
    saveSchedule(date, selectedTime);
  }

  function quickPick(daysOffset: number) {
    const d = new Date();
    d.setDate(d.getDate() + daysOffset);
    d.setHours(0, 0, 0, 0);
    selectDate(d);
  }

  // ── Time actions ────────────────────────────────────────────────────────────

  function applySelectTime(hour24: number, minute: number, keepCustom = false) {
    setSelectedTime({ hour24, minute });
    setFocusedTimeIdx(null);
    if (!keepCustom) setCustomTimeEntry(null);
    const date =
      selectedDate ??
      (() => {
        const d = new Date();
        d.setHours(0, 0, 0, 0);
        return d;
      })();
    if (!selectedDate) setSelectedDate(date);
    saveSchedule(date, { hour24, minute });
  }

  function handleSlotClick(slot: DisplaySlot) {
    const isCustomSlot =
      slot.isCustom === true &&
      customTimeEntry?.hour24 === slot.hour24 &&
      customTimeEntry?.minute === slot.minute;
    applySelectTime(slot.hour24, slot.minute, isCustomSlot);
  }

  function clearTime() {
    setSelectedTime(null);
    setCustomTimeEntry(null);
    setDurationMinutes(null);
    saveDuration(null);
    if (selectedDate) saveSchedule(selectedDate, null);
  }

  function applyCustomTime() {
    if (!customTimeStr.trim()) return;
    const parsed = parseCustomTime(customTimeStr);
    if (!parsed) {
      setCustomTimeStr("");
      return;
    }

    const { hour24, minute } = parsed;

    // Exact match on a 15-min preset → select that preset, no custom entry
    const presetMatch = TIME_SLOTS.find((s) => s.hour24 === hour24 && s.minute === minute);
    if (presetMatch) {
      setCustomTimeEntry(null);
      applySelectTime(hour24, minute, false);
      scrollToTime(hour24, minute);
    } else {
      // Inject a custom entry into the list and select it
      const label = fmt12(hour24, minute);
      setCustomTimeEntry({ hour24, minute, label });
      setSelectedTime({ hour24, minute });
      setFocusedTimeIdx(null);
      const date =
        selectedDate ??
        (() => {
          const d = new Date();
          d.setHours(0, 0, 0, 0);
          return d;
        })();
      if (!selectedDate) setSelectedDate(date);
      saveSchedule(date, { hour24, minute });
      scrollToTime(hour24, minute);
    }

    setCustomTimeStr("");
  }

  function handleTimeListKeyDown(e: React.KeyboardEvent) {
    const maxIdx = displayedSlots.length - 1;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      const selIdx = selectedTime
        ? displayedSlots.findIndex(
            (s) => s.hour24 === selectedTime.hour24 && s.minute === selectedTime.minute
          )
        : -1;
      const from = focusedTimeIdx ?? (selIdx !== -1 ? selIdx : 63);
      const next = Math.min(from + 1, maxIdx);
      setFocusedTimeIdx(next);
      const slot = displayedSlots[next];
      if (slot) scrollToTime(slot.hour24, slot.minute);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      const selIdx = selectedTime
        ? displayedSlots.findIndex(
            (s) => s.hour24 === selectedTime.hour24 && s.minute === selectedTime.minute
          )
        : -1;
      const from = focusedTimeIdx ?? (selIdx !== -1 ? selIdx : 65);
      const next = Math.max(from - 1, 0);
      setFocusedTimeIdx(next);
      const slot = displayedSlots[next];
      if (slot) scrollToTime(slot.hour24, slot.minute);
    } else if (e.key === "Enter" && focusedTimeIdx !== null) {
      e.preventDefault();
      const slot = displayedSlots[focusedTimeIdx];
      if (slot) handleSlotClick(slot);
    }
  }

  // ── Duration actions ────────────────────────────────────────────────────────

  function selectDuration(mins: number | null) {
    setDurationMinutes(mins);
    saveDuration(mins);
  }

  function applyCustomDuration() {
    const parsed = parseInt(customDurationStr);
    if (!isNaN(parsed) && parsed > 0) selectDuration(parsed);
    setCustomDurationActive(false);
    setCustomDurationStr("");
  }

  // ── Clear all ───────────────────────────────────────────────────────────────

  function handleClear() {
    void clearSchedule(page.id);
    updatePage(page.id, { durationMinutes: null });
    setOpen(false);
  }

  // ── Computed ────────────────────────────────────────────────────────────────

  const hasDate = Boolean(page.scheduledStart);
  const { label: triggerLabel, isPast } = page.scheduledStart
    ? fmtTrigger(page.scheduledStart, page.durationMinutes, isDone)
    : { label: "Schedule", isPast: false };

  const endTimeLabel =
    selectedTime !== null && durationMinutes !== null
      ? computeEndLabel(selectedTime.hour24, selectedTime.minute, durationMinutes)
      : null;

  const isCustomDuration =
    durationMinutes !== null && !DURATION_PRESETS.some((p) => p.minutes === durationMinutes);

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <button
          className={cn(
            "inline-flex cursor-pointer items-center gap-1 rounded transition-colors hover:text-muted-foreground focus:outline-none",
            isPast && "text-red-500 hover:text-red-400",
            !hasDate && "text-muted-foreground/60"
          )}
          aria-label={hasDate ? `Scheduled: ${triggerLabel}` : "Set schedule"}
        >
          <Calendar size={15} aria-hidden="true" />
          <span>{triggerLabel}</span>
        </button>
      </PopoverTrigger>

      {/* w-[380px]: calendar needs ~220px, time panel 128px, gap 12px, padding 2×12px */}
      <PopoverContent align="start" className="w-[380px] p-0">
        <div className="p-3">
          {/* ── Quick picks — plain text links, no background ── */}
          <div className="flex w-full items-start justify-between">
            <div className="mb-3 flex items-center gap-0.5 text-xs">
              {(
                [
                  ["Today", 0],
                  ["Tomorrow", 1],
                  ["Next week", 7],
                ] as const
              ).map(([label, offset], i) => {
                const isActive =
                  selectedDate !== null &&
                  (() => {
                    const d = new Date();
                    d.setDate(d.getDate() + offset);
                    return (
                      selectedDate.getFullYear() === d.getFullYear() &&
                      selectedDate.getMonth() === d.getMonth() &&
                      selectedDate.getDate() === d.getDate()
                    );
                  })();
                return (
                  <span key={label} className="flex items-center">
                    {i > 0 && (
                      <span className="mx-1.5 text-muted-foreground/25" aria-hidden="true">
                        ·
                      </span>
                    )}
                    <button
                      onClick={() => quickPick(offset)}
                      className={cn(
                        "cursor-pointer transition-colors",
                        isActive
                          ? "font-medium text-primary"
                          : "text-foreground/55 hover:text-foreground"
                      )}
                    >
                      {label}
                    </button>
                  </span>
                );
              })}
            </div>

            {hasDate && (
              <button
                onClick={handleClear}
                className="cursor-pointer text-xs text-foreground/55 hover:text-foreground"
              >
                Clear
              </button>
            )}
          </div>

          {/* ── Two-column: calendar + time ── */}
          <div className="flex items-start gap-3" style={{ height: CAL_HEIGHT }}>
            {/* Calendar — flex-1 */}
            <div className="min-w-0 flex-1">
              <MiniCalendar
                year={viewYear}
                month={viewMonth}
                selectedDate={selectedDate}
                onSelect={selectDate}
                onPrev={() => {
                  if (viewMonth === 0) {
                    setViewMonth(11);
                    setViewYear((y) => y - 1);
                  } else {
                    setViewMonth((m) => m - 1);
                  }
                }}
                onNext={() => {
                  if (viewMonth === 11) {
                    setViewMonth(0);
                    setViewYear((y) => y + 1);
                  } else {
                    setViewMonth((m) => m + 1);
                  }
                }}
              />
            </div>

            {/* Time panel — fixed 128px, explicit height so flex-1 scroll centering works */}
            <div
              className="flex w-32 shrink-0 flex-col gap-1.5 border-l border-border/40 pl-3"
              style={{ height: CAL_HEIGHT }}
            >
              {/* All day — subtle text toggle, no filled background */}
              <button
                onClick={clearTime}
                className={cn(
                  "cursor-pointer self-start text-xs transition-colors",
                  selectedTime === null
                    ? "font-medium text-primary"
                    : "text-foreground/40 hover:text-foreground"
                )}
                aria-label="All day — no specific time"
              >
                All day
              </button>

              {/* Scrollable time slot list — scrollbar hidden (macOS overlaid anyway) */}
              <div
                ref={timeListRef}
                role="listbox"
                aria-label="Select start time"
                tabIndex={0}
                onKeyDown={handleTimeListKeyDown}
                onFocus={() => {
                  if (focusedTimeIdx === null) {
                    const selIdx = selectedTime
                      ? displayedSlots.findIndex(
                          (s) =>
                            s.hour24 === selectedTime.hour24 && s.minute === selectedTime.minute
                        )
                      : -1;
                    setFocusedTimeIdx(selIdx !== -1 ? selIdx : 32);
                  }
                }}
                onBlur={(e) => {
                  if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
                    setFocusedTimeIdx(null);
                  }
                }}
                className="min-h-0 flex-1 overflow-y-auto rounded-sm focus:outline-none [&::-webkit-scrollbar]:hidden"
              >
                {displayedSlots.map((slot, displayIdx) => {
                  const isSel =
                    selectedTime !== null &&
                    selectedTime.hour24 === slot.hour24 &&
                    selectedTime.minute === slot.minute;
                  const isFoc = focusedTimeIdx === displayIdx;
                  return (
                    <button
                      key={slot.isCustom ? `custom-${slot.hour24}-${slot.minute}` : slot.idx}
                      tabIndex={-1}
                      role="option"
                      aria-selected={isSel}
                      data-h={slot.hour24}
                      data-m={slot.minute}
                      onClick={() => handleSlotClick(slot)}
                      className={cn(
                        "flex w-full cursor-pointer rounded px-1.5 py-[3px] text-left text-xs transition-colors",
                        isSel
                          ? "font-medium text-primary"
                          : isFoc
                            ? "bg-accent text-foreground"
                            : "text-foreground/55 hover:text-foreground"
                      )}
                    >
                      {slot.label}
                    </button>
                  );
                })}
              </div>

              {/* Custom time input — borderless, blends into panel */}
              <input
                type="text"
                placeholder="or type a time…"
                value={customTimeStr}
                onChange={(e) => setCustomTimeStr(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    applyCustomTime();
                  }
                  if (e.key === "Escape") setCustomTimeStr("");
                }}
                onBlur={applyCustomTime}
                className="w-full cursor-text border-none bg-transparent px-0.5 py-1 text-xs text-foreground/80 outline-none placeholder:text-muted-foreground/25"
              />
            </div>
          </div>
        </div>

        {/* ── Duration section — hidden for all-day events ── */}
        {selectedTime !== null && (
          <div className="border-t border-border/60 px-3 py-2.5">
            <div className="flex flex-wrap items-center gap-1.5">
              {DURATION_PRESETS.map(({ label, minutes }) => {
                const isActive = durationMinutes === minutes;
                return (
                  <button
                    key={minutes}
                    onClick={() => selectDuration(isActive ? null : minutes)}
                    aria-pressed={isActive}
                    aria-label={`Duration: ${label}`}
                    className={cn(
                      "cursor-pointer rounded px-1.5 py-0.5 text-xs transition-colors",
                      isActive
                        ? "font-medium text-primary"
                        : "text-foreground/55 hover:text-foreground"
                    )}
                  >
                    {label}
                  </button>
                );
              })}

              {/* Custom duration — fixed-width wrapper prevents layout shift on toggle */}
              <div className="flex w-12 shrink-0 items-center">
                {customDurationActive ? (
                  <input
                    autoFocus
                    type="text"
                    inputMode="numeric"
                    placeholder="min"
                    value={customDurationStr}
                    onChange={(e) => setCustomDurationStr(e.target.value.replace(/\D/g, ""))}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        applyCustomDuration();
                      }
                      if (e.key === "Escape") {
                        setCustomDurationActive(false);
                        setCustomDurationStr("");
                      }
                    }}
                    onBlur={applyCustomDuration}
                    className="h-6 w-full cursor-text border-none bg-transparent px-0.5 text-xs text-foreground/80 outline-none placeholder:text-muted-foreground/25"
                  />
                ) : (
                  <button
                    onClick={() => {
                      setCustomDurationStr(
                        durationMinutes !== null && isCustomDuration ? String(durationMinutes) : ""
                      );
                      setCustomDurationActive(true);
                    }}
                    aria-pressed={isCustomDuration}
                    className={cn(
                      "h-6 w-full cursor-pointer rounded px-1.5 text-xs transition-colors",
                      isCustomDuration
                        ? "font-medium text-primary"
                        : "text-foreground/55 hover:text-foreground"
                    )}
                  >
                    {isCustomDuration && durationMinutes !== null
                      ? fmtDuration(durationMinutes)
                      : "Custom"}
                  </button>
                )}
              </div>

              {/* End time — only shown when time + duration are both set */}
              {endTimeLabel && selectedTime && (
                <p className="ml-auto text-xs text-foreground/60">
                  {fmt12(selectedTime.hour24, selectedTime.minute)}
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
