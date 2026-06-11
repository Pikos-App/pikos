// All changes apply immediately via onChange — no internal uncommitted state.

import { isAllDayIso, parseLocalISO } from "@pikos/core";
import {
  addDays,
  addMinutes,
  differenceInCalendarDays,
  format,
  getHours,
  getMinutes,
  isSameDay,
  startOfDay,
} from "date-fns";
import { Calendar, Pencil } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { useAppSettings } from "@/shared/context/AppSettingsContext";
import { useMonthNav } from "@/shared/hooks/useMonthNav";

import {
  computeEndTimeLabel,
  DAYS_PRESETS,
  DURATION_PRESETS,
  formatDurationLabel,
  formatTimeOfDay,
  formatTriggerLabel,
  parseCustomDurationStr,
  parseCustomTimeStr,
  TIME_SLOTS,
  type TimeSlot,
  toISODateOnly,
  toISODateTime,
} from "./DateTimePicker.utils";
import { CAL_HEIGHT, MiniCalendar } from "./MiniCalendar";

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
  /** Fires when the popover transitions from open to closed (any cause). */
  onClose?: () => void;
}

export function DateTimePicker({
  endValue,
  isDone = false,
  onChange,
  onClose,
  onEndChange,
  value,
}: DateTimePickerProps) {
  const { weekStart } = useAppSettings();
  const [open, setOpen] = useState(false);

  const monthNav = useMonthNav();

  // Virtual slot inserted into the time list for non-15-minute times.
  const [customTimeEntry, setCustomTimeEntry] = useState<{
    hour24: number;
    minute: number;
    label: string;
  } | null>(null);

  const [focusedSlotIdx, setFocusedSlotIdx] = useState<number | null>(null);

  const [customTimeStr, setCustomTimeStr] = useState("");
  const [customDurationActive, setCustomDurationActive] = useState(false);
  const [customDurationStr, setCustomDurationStr] = useState("");
  const [endDatePopoverOpen, setEndDatePopoverOpen] = useState(false);
  const endMonthNav = useMonthNav();

  const timeListRef = useRef<HTMLDivElement>(null);

  const parsedValue = value ? parseLocalISO(value) : null;
  const selectedDate = parsedValue ? startOfDay(parsedValue) : null;
  const selectedTime =
    value && !isAllDayIso(value) && parsedValue
      ? { hour24: getHours(parsedValue), minute: getMinutes(parsedValue) }
      : null;

  function handleOpenChange(next: boolean) {
    if (next) {
      monthNav.reset(parsedValue ?? new Date());
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

  type DisplaySlot = TimeSlot & { isCustom?: true };

  const displayedSlots: DisplaySlot[] = (() => {
    if (!customTimeEntry) return TIME_SLOTS;
    const customMinutes = customTimeEntry.hour24 * 60 + customTimeEntry.minute;
    const insertAt = TIME_SLOTS.findIndex((slot) => slot.hour24 * 60 + slot.minute > customMinutes);
    const entry: DisplaySlot = { idx: -1, ...customTimeEntry, isCustom: true };
    if (insertAt === -1) return [...TIME_SLOTS, entry];
    return [...TIME_SLOTS.slice(0, insertAt), entry, ...TIME_SLOTS.slice(insertAt)];
  })();

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

  // ── Wheel-to-scroll the time list ──────────────────────────────────────────
  // A native non-passive listener is required: React's onWheel is passive (it
  // can't preventDefault), and when this popover opens from a modal Dialog
  // (e.g. Quick Add) react-remove-scroll's wheel lock blocks native scrolling
  // of content portaled outside the dialog. We attach via a callback ref
  // (not an effect) because Radix mounts the popover content a tick after
  // `open` flips, so a ref read in an effect would still be null. Scrolling
  // the list ourselves and preventing the default gives a single, consistent
  // scroll in every context.

  const detachWheel = useRef<(() => void) | null>(null);

  function setTimeListNode(node: HTMLDivElement | null) {
    timeListRef.current = node;
    detachWheel.current?.();
    detachWheel.current = null;
    if (!node) return;
    const onWheel = (event: WheelEvent) => {
      if (node.scrollHeight <= node.clientHeight) return;
      event.preventDefault();
      node.scrollTop += event.deltaY;
    };
    node.addEventListener("wheel", onWheel, { passive: false });
    detachWheel.current = () => node.removeEventListener("wheel", onWheel);
  }

  function selectDate(date: Date) {
    monthNav.reset(date);
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

  function selectDuration(minutes: number | null) {
    if (!onEndChange) return;
    if (minutes === null) {
      onEndChange(null);
      return;
    }
    const startDate = value ? parseLocalISO(value) : null;
    if (!startDate || isAllDayIso(value!)) return;
    const endDate = addMinutes(startDate, minutes);
    onEndChange(toISODateTime(endDate, getHours(endDate), getMinutes(endDate)));
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

  /** Set the end date for an all-day event. `days` = span length (2 = start + 1). */
  function selectEndDays(days: number | null) {
    if (!onEndChange) return;
    if (!selectedDate) return;
    if (days === null || days <= 1) {
      onEndChange(null);
      return;
    }
    onEndChange(toISODateOnly(addDays(selectedDate, days - 1)));
  }

  function selectEndDate(date: Date) {
    if (!onEndChange || !selectedDate) return;
    if (date <= selectedDate) {
      onEndChange(null);
      return;
    }
    onEndChange(toISODateOnly(date));
  }

  function handleClearAll() {
    onChange(null);
    setOpen(false);
  }

  const hasDate = value !== null;
  const {
    isDueSoon,
    isPast,
    label: triggerLabel,
  } = value
    ? formatTriggerLabel(value, endValue, isDone)
    : { isDueSoon: false, isPast: false, label: "Schedule" };

  const durationMinutes =
    value && !isAllDayIso(value) && endValue && !isAllDayIso(endValue)
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

  const showEndDateSection = onEndChange !== undefined && hasDate && selectedTime === null;

  const endDate =
    endValue && isAllDayIso(endValue) && selectedDate ? parseLocalISO(endValue) : null;
  const spanDays =
    endDate && selectedDate ? differenceInCalendarDays(endDate, selectedDate) + 1 : 1;
  const isCustomSpan = spanDays > 1 && !DAYS_PRESETS.some((preset) => preset.days === spanDays);

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
                  : "text-subtle hover:text-muted-foreground"
          )}
        >
          <Calendar aria-hidden="true" size={13} />
          <span>{triggerLabel}</span>
        </button>
      </PopoverTrigger>

      <PopoverContent
        align="start"
        aria-label="Schedule picker"
        className="w-[380px] p-0"
        {...(onClose && {
          onCloseAutoFocus: (e: Event) => {
            e.preventDefault();
            onClose();
          },
        })}
      >
        <div className="p-3">
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
                const isActive = selectedDate !== null && isSameDay(selectedDate, pickDate);
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

          <div className="flex items-start gap-3" style={{ height: CAL_HEIGHT }}>
            <div className="min-w-0 flex-1">
              <MiniCalendar
                month={monthNav.month}
                onNext={monthNav.next}
                onPrev={monthNav.prev}
                onSelect={selectDate}
                selectedDate={selectedDate}
                weekStartsOn={weekStart}
                year={monthNav.year}
              />
            </div>

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
                ref={setTimeListNode}
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

        {showEndDateSection && (
          <div className="border-t border-border/60 px-3 py-2.5">
            <div className="flex flex-wrap items-center gap-1.5">
              {DAYS_PRESETS.map(({ days, label }) => {
                const isActive = spanDays === days;
                return (
                  <button
                    aria-label={`Ends in ${label}`}
                    aria-pressed={isActive}
                    className={cn(
                      "rounded px-1.5 py-0.5 text-xs transition-colors",
                      isActive
                        ? "font-medium text-primary"
                        : "text-foreground/55 hover:text-foreground"
                    )}
                    key={days}
                    onClick={() => selectEndDays(isActive ? null : days)}
                  >
                    {label}
                  </button>
                );
              })}

              <Popover
                onOpenChange={(next) => {
                  if (next) endMonthNav.reset(endDate ?? selectedDate ?? new Date());
                  setEndDatePopoverOpen(next);
                }}
                open={endDatePopoverOpen}
              >
                <PopoverTrigger asChild>
                  <button
                    aria-label={
                      isCustomSpan
                        ? `Edit custom end date (${spanDays}d)`
                        : "Pick a custom end date"
                    }
                    aria-pressed={isCustomSpan}
                    className={cn(
                      "group inline-flex h-6 shrink-0 items-center gap-1 rounded px-1.5 text-xs transition-colors",
                      isCustomSpan
                        ? "font-medium text-primary"
                        : "text-foreground/55 hover:text-foreground"
                    )}
                  >
                    <span>{isCustomSpan ? `${spanDays}d` : "Custom"}</span>
                    <Pencil
                      aria-hidden="true"
                      className="text-muted-foreground/60 transition-opacity group-hover:text-foreground"
                      size={10}
                    />
                  </button>
                </PopoverTrigger>
                <PopoverContent
                  align="start"
                  className="w-[260px] p-3"
                  side="bottom"
                  sideOffset={4}
                >
                  <MiniCalendar
                    month={endMonthNav.month}
                    onNext={endMonthNav.next}
                    onPrev={endMonthNav.prev}
                    onSelect={(date) => {
                      selectEndDate(date);
                      setEndDatePopoverOpen(false);
                    }}
                    selectedDate={endDate}
                    weekStartsOn={weekStart}
                    year={endMonthNav.year}
                  />
                </PopoverContent>
              </Popover>

              {selectedDate && spanDays > 1 && endDate && (
                <p className="ml-auto text-xs text-foreground/60">
                  {format(selectedDate, "MMM d")}
                  <span className="mx-1 text-foreground/30">→</span>
                  {format(endDate, "MMM d")}
                </p>
              )}
            </div>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
