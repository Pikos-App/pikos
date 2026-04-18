// RecurrencePopover — controlled RRULE editor used by the page byline,
// QuickAddDialog, and PageBlockPopover.
//
// Layout, top → bottom:
//   1. Preset rows in TickTick style: bold label + muted parenthetical anchor
//      detail, grouped as regular cadence / every weekday / custom.
//   2. Custom… — expanded only when user taps it, or when current rule shape
//      doesn't match any preset. Inline single-row freq+interval ("Every N
//      Day/Week/Month/Year"), plus weekday pills when weekly.
//   3. Ends — segmented Never/On/After with inline controls below.
//   4. Preview + Stop repeating.

import {
  buildRrule,
  formatDateOnly,
  parseLocalISO,
  parseRrule,
  type RecurrenceFreq,
  type RecurrenceOptions,
  type RecurrenceWeekday,
  rruleToLabel,
  rruleToShortLabel,
} from "@pikos/core";
import { addMonths, format } from "date-fns";
import { CalendarDays, Check, ChevronDown, Repeat2 } from "lucide-react";
import { useState } from "react";

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useAppSettings } from "@/shared/context/AppSettingsContext";

import { MiniCalendar } from "./DateTimePicker";

// ── Constants ─────────────────────────────────────────────────────────────────

const FREQ_UNIT_LABELS: Record<RecurrenceFreq, { singular: string; plural: string }> = {
  DAILY: { plural: "Days", singular: "Day" },
  MONTHLY: { plural: "Months", singular: "Month" },
  WEEKLY: { plural: "Weeks", singular: "Week" },
  YEARLY: { plural: "Years", singular: "Year" },
};

// rrule.js convention: 0 = Monday, 6 = Sunday.
const WEEKDAYS: { value: RecurrenceWeekday; short: string; full: string; abbr: string }[] = [
  { abbr: "Mon", full: "Monday", short: "M", value: 0 },
  { abbr: "Tue", full: "Tuesday", short: "T", value: 1 },
  { abbr: "Wed", full: "Wednesday", short: "W", value: 2 },
  { abbr: "Thu", full: "Thursday", short: "T", value: 3 },
  { abbr: "Fri", full: "Friday", short: "F", value: 4 },
  { abbr: "Sat", full: "Saturday", short: "S", value: 5 },
  { abbr: "Sun", full: "Sunday", short: "S", value: 6 },
];

const MONTH_NAMES_SHORT = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

// ── Props ─────────────────────────────────────────────────────────────────────

interface RecurrencePopoverProps {
  /** Current RRULE string (no "RRULE:" prefix) or null for "no recurrence". */
  rrule: string | null;
  /** Emit the new RRULE string, or null to clear the recurrence. */
  onChange: (rrule: string | null) => void;
  /**
   * ISO start date of the anchor occurrence (page.scheduledStart or equivalent).
   * Used to derive contextual preset labels ("Weekly (Thu)", "Yearly (Apr 16)").
   * When absent, presets are hidden and only Custom controls appear.
   */
  anchorDate?: string | null;
  /** When true, chip is greyed out and popover cannot open. */
  disabled?: boolean;
  /** When true, chip displays the cadence but doesn't open. */
  readOnly?: boolean;
  /** Tooltip shown on the disabled chip (e.g., "Set a date first"). */
  disabledHint?: string;
  /**
   * "label" (default) — icon + cadence text always; used in PageBlockPopover,
   *   VirtualPageBlockPopover, MetadataHeader.
   * "icon" — icon-only with a hover tooltip; used in the page byline.
   * "compact" — icon-only when no rule / override, icon + short label when
   *   set; used in QuickAddDialog so the empty state is unobtrusive.
   */
  variant?: "icon" | "label" | "compact";
  /**
   * External label shown next to the icon (in compact/label modes) when no
   * rrule is set. Used by QuickAddDialog to display NLP finite previews like
   * "3 occurrences" in the same trigger as the recurrence icon.
   */
  overrideLabel?: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Convert JS Date.getDay() (0=Sun) to rrule.js index (0=Mon). */
function jsDayToRrule(jsDay: number): RecurrenceWeekday {
  return ((jsDay + 6) % 7) as RecurrenceWeekday;
}

function ordinalSuffix(n: number): string {
  const rem10 = n % 10;
  const rem100 = n % 100;
  if (rem10 === 1 && rem100 !== 11) return "st";
  if (rem10 === 2 && rem100 !== 12) return "nd";
  if (rem10 === 3 && rem100 !== 13) return "rd";
  return "th";
}

interface Preset {
  id: string;
  label: string;
  /** Optional parenthetical detail shown muted after the label. */
  detail?: string;
  options: RecurrenceOptions;
  /** True to render with a divider *above* this row. */
  startsGroup?: boolean;
}

/** Shape-compare two RecurrenceOptions, ignoring end conditions (count/until). */
function shapesMatch(a: RecurrenceOptions, b: RecurrenceOptions): boolean {
  if (a.freq !== b.freq) return false;
  if (a.interval !== b.interval) return false;
  const aDays = (a.byweekday ?? []).join(",");
  const bDays = (b.byweekday ?? []).join(",");
  return aDays === bDays;
}

function computePresets(anchor: Date): Preset[] {
  const weekday = jsDayToRrule(anchor.getDay());
  const weekdayAbbr = WEEKDAYS[weekday]!.abbr;
  const dayOfMonth = anchor.getDate();
  const monthName = MONTH_NAMES_SHORT[anchor.getMonth()]!;
  return [
    { id: "daily", label: "Daily", options: { freq: "DAILY", interval: 1 } },
    {
      detail: `${weekdayAbbr}`,
      id: "weekly",
      label: "Weekly",
      options: { byweekday: [weekday], freq: "WEEKLY", interval: 1 },
    },
    {
      detail: `${weekdayAbbr}`,
      id: "biweekly",
      label: "Every 2 weeks",
      options: { byweekday: [weekday], freq: "WEEKLY", interval: 2 },
    },
    {
      detail: `${dayOfMonth}${ordinalSuffix(dayOfMonth)}`,
      id: "monthly",
      label: "Monthly",
      options: { freq: "MONTHLY", interval: 1 },
    },
    {
      detail: `${monthName} ${dayOfMonth}`,
      id: "yearly",
      label: "Yearly",
      options: { freq: "YEARLY", interval: 1 },
    },
    {
      detail: "Mon – Fri",
      id: "weekdays",
      label: "Every weekday",
      options: { byweekday: [0, 1, 2, 3, 4], freq: "WEEKLY", interval: 1 },
      startsGroup: true,
    },
  ];
}

function formatTriggerLabel(rrule: string | null, short: boolean): string {
  if (!rrule) return "Does not repeat";
  return short ? rruleToShortLabel(rrule) : rruleToLabel(rrule);
}

function formatEndDateLabel(iso: string | undefined): string {
  if (!iso) return "Pick date";
  const d = parseLocalISO(iso);
  return format(d, "MMM d, yyyy");
}

// ── Component ─────────────────────────────────────────────────────────────────

export function RecurrencePopover({
  anchorDate,
  disabled = false,
  disabledHint,
  onChange,
  overrideLabel,
  readOnly = false,
  rrule,
  variant = "label",
}: RecurrencePopoverProps) {
  const { weekStart } = useAppSettings();
  const [open, setOpen] = useState(false);
  const [customManuallyExpanded, setCustomManuallyExpanded] = useState(false);
  const [unitMenuOpen, setUnitMenuOpen] = useState(false);
  const [untilCalendarOpen, setUntilCalendarOpen] = useState(false);
  const [untilViewYear, setUntilViewYear] = useState(new Date().getFullYear());
  const [untilViewMonth, setUntilViewMonth] = useState(new Date().getMonth());

  // Local draft state for numeric inputs — only emits on commit (blur/Enter)
  // so intermediate keystrokes never emit invalid rrules.
  const [countDraft, setCountDraft] = useState<string>("");
  const [intervalDraft, setIntervalDraft] = useState<string>("");
  const [intervalFocused, setIntervalFocused] = useState(false);
  const [countFocused, setCountFocused] = useState(false);

  const options = rrule ? parseRrule(rrule) : null;
  const hasRule = options !== null;
  // Short form in the trigger; full form stays in the popover preview.
  // overrideLabel wins when no rule is set (e.g. finite NLP "3 occurrences").
  const triggerLabel = hasRule
    ? formatTriggerLabel(rrule, /* short */ true)
    : (overrideLabel ?? formatTriggerLabel(rrule, /* short */ true));
  // Screen readers don't see the adjacent date chip that visually conveys
  // BYDAY, so the aria-label carries the full cadence ("every week on
  // Monday") even when the visible text is the short "Weekly".
  const ariaTriggerLabel = hasRule
    ? formatTriggerLabel(rrule, /* short */ false)
    : (overrideLabel ?? formatTriggerLabel(rrule, /* short */ false));

  const anchor = anchorDate ? parseLocalISO(anchorDate) : new Date();
  const presets = computePresets(anchor);

  const activePreset = options
    ? (presets.find((p) => shapesMatch(options, p.options)) ?? null)
    : null;
  const isCustomShape = hasRule && !activePreset;
  const customVisible = isCustomShape || customManuallyExpanded;

  // ── Emit helpers ─────────────────────────────────────────────────────────────

  function emit(next: RecurrenceOptions | null) {
    onChange(next ? buildRrule(next) : null);
  }

  function withEndCondition(shape: RecurrenceOptions): RecurrenceOptions {
    // Preset clicks preserve the current Ends condition (count/until) but
    // replace freq/interval/byweekday.
    const merged: RecurrenceOptions = { ...shape };
    if (options?.count != null) merged.count = options.count;
    else if (options?.until) merged.until = options.until;
    return merged;
  }

  function handleSelectPreset(preset: Preset) {
    setCustomManuallyExpanded(false);
    emit(withEndCondition(preset.options));
  }

  function handleSelectFreq(freq: RecurrenceFreq) {
    const base: RecurrenceOptions = options
      ? { ...options, freq, interval: options.interval }
      : { freq, interval: 1 };
    // BYDAY only meaningful for WEEKLY.
    if (freq !== "WEEKLY") delete base.byweekday;
    emit(base);
    setUnitMenuOpen(false);
  }

  function handleIntervalCommit() {
    setIntervalFocused(false);
    if (!options) return;
    const parsed = parseInt(intervalDraft, 10);
    if (!isNaN(parsed) && parsed > 0) emit({ ...options, interval: parsed });
    setIntervalDraft("");
  }

  function handleToggleWeekday(day: RecurrenceWeekday) {
    if (!options) return;
    const current = options.byweekday ?? [];
    const next = current.includes(day) ? current.filter((d) => d !== day) : [...current, day];
    const sorted = [...next].sort((a, b) => a - b);
    const nextOpts: RecurrenceOptions = { ...options };
    if (sorted.length === 0) delete nextOpts.byweekday;
    else nextOpts.byweekday = sorted;
    emit(nextOpts);
  }

  function handleSelectEnd(type: "never" | "until" | "count") {
    if (!options) return;
    const next: RecurrenceOptions = {
      freq: options.freq,
      interval: options.interval,
    };
    if (options.byweekday) next.byweekday = options.byweekday;
    if (type === "until") {
      next.until = options.until ?? format(addMonths(new Date(), 3), "yyyy-MM-dd");
    } else if (type === "count") {
      next.count = options.count ?? 10;
    }
    emit(next);
  }

  function handleUntilSelect(date: Date) {
    if (!options) return;
    const next: RecurrenceOptions = {
      freq: options.freq,
      interval: options.interval,
      until: formatDateOnly(date),
    };
    if (options.byweekday) next.byweekday = options.byweekday;
    emit(next);
    setUntilCalendarOpen(false);
  }

  function handleCountCommit() {
    setCountFocused(false);
    if (!options) return;
    const parsed = parseInt(countDraft, 10);
    if (!isNaN(parsed) && parsed > 0) {
      const next: RecurrenceOptions = {
        count: parsed,
        freq: options.freq,
        interval: options.interval,
      };
      if (options.byweekday) next.byweekday = options.byweekday;
      emit(next);
    }
    setCountDraft("");
  }

  function handleOpenChange(next: boolean) {
    if (readOnly || disabled) return;
    if (!next) {
      setCountDraft("");
      setIntervalDraft("");
      setIntervalFocused(false);
      setCountFocused(false);
      setCustomManuallyExpanded(false);
      setUntilCalendarOpen(false);
      setUnitMenuOpen(false);
    } else if (options?.until) {
      const d = parseLocalISO(options.until);
      setUntilViewYear(d.getFullYear());
      setUntilViewMonth(d.getMonth());
    }
    setOpen(next);
  }

  const endType: "never" | "until" | "count" =
    options?.count != null ? "count" : options?.until ? "until" : "never";

  const intervalDisplay = intervalFocused ? intervalDraft : String(options?.interval ?? 1);
  const countDisplay = countFocused
    ? countDraft
    : options?.count != null
      ? String(options.count)
      : "";

  // ── Trigger ──────────────────────────────────────────────────────────────────

  // In compact mode the label appears only when a rule or override is set —
  // so the empty state renders as icon-only (no "Does not repeat" text).
  const hasLabelContent = hasRule || !!overrideLabel;
  const showLabel = variant === "label" || (variant === "compact" && hasLabelContent);
  const isIconOnly = variant === "icon" || !showLabel;
  const iconTooltipText = disabled
    ? (disabledHint ?? "Set a date first")
    : hasLabelContent
      ? triggerLabel
      : "Set recurrence";

  const triggerButton = (
    <button
      aria-label={hasLabelContent ? `Recurrence: ${ariaTriggerLabel}` : "Set recurrence"}
      className={cn(
        "inline-flex items-center gap-1 rounded transition-colors focus:outline-none",
        isIconOnly
          ? "shrink-0 whitespace-nowrap"
          : // In label mode allow the chip to shrink inside a bounded flex row
            // (e.g. PageBlockPopover's metadata row); the label itself truncates
            // with an ellipsis. Icon never shrinks.
            "min-w-0 text-sm",
        disabled
          ? "cursor-not-allowed text-muted-foreground/30"
          : readOnly
            ? "text-muted-foreground"
            : hasLabelContent
              ? "text-muted-foreground hover:text-foreground"
              : "text-muted-foreground/60 hover:text-muted-foreground"
      )}
      disabled={disabled || readOnly}
      type="button"
    >
      <Repeat2 aria-hidden="true" className="shrink-0" size={13} />
      {showLabel && <span className="truncate">{triggerLabel}</span>}
    </button>
  );

  if (disabled || readOnly) {
    if (isIconOnly) {
      return (
        <Tooltip>
          <TooltipTrigger asChild>{triggerButton}</TooltipTrigger>
          <TooltipContent side="bottom">{iconTooltipText}</TooltipContent>
        </Tooltip>
      );
    }
    return triggerButton;
  }

  // ── Render ───────────────────────────────────────────────────────────────────

  return (
    <Popover onOpenChange={handleOpenChange} open={open}>
      {isIconOnly ? (
        <Tooltip>
          <PopoverTrigger asChild>
            <TooltipTrigger asChild>{triggerButton}</TooltipTrigger>
          </PopoverTrigger>
          <TooltipContent side="bottom">{iconTooltipText}</TooltipContent>
        </Tooltip>
      ) : (
        <PopoverTrigger asChild>{triggerButton}</PopoverTrigger>
      )}

      <PopoverContent align="start" className="w-[260px] p-0">
        {/* ── Presets ─────────────────────────────────────────────────────── */}
        {presets.length > 0 && (
          <div className="flex flex-col py-1">
            {presets.map((preset) => {
              const isActive = activePreset?.id === preset.id;
              return (
                <div key={preset.id}>
                  {preset.startsGroup && <div className="my-1 border-t border-border/40" />}
                  <button
                    aria-pressed={isActive}
                    className={cn(
                      "flex w-full items-center justify-between px-3 py-1.5 text-left text-sm transition-colors",
                      isActive
                        ? "text-primary"
                        : "text-foreground/80 hover:bg-accent hover:text-foreground"
                    )}
                    onClick={() => handleSelectPreset(preset)}
                    type="button"
                  >
                    <span className="flex items-baseline gap-1.5">
                      <span>{preset.label}</span>
                      {preset.detail && (
                        <span
                          className={cn(
                            "text-xs",
                            isActive ? "text-primary/60" : "text-muted-foreground/60"
                          )}
                        >
                          {preset.detail}
                        </span>
                      )}
                    </span>
                    {isActive && <Check aria-hidden="true" size={12} strokeWidth={2.5} />}
                  </button>
                </div>
              );
            })}

            {/* Custom toggle row */}
            <div className="my-1 border-t border-border/40" />
            <button
              aria-expanded={customVisible}
              className={cn(
                "flex w-full items-center justify-between px-3 py-1.5 text-left text-sm transition-colors",
                isCustomShape
                  ? "text-primary"
                  : "text-foreground/70 hover:bg-accent hover:text-foreground"
              )}
              onClick={() => {
                if (isCustomShape) return; // Can't collapse when custom is the active shape.
                setCustomManuallyExpanded((prev) => !prev);
              }}
              type="button"
            >
              <span>Custom…</span>
              {isCustomShape ? (
                <Check aria-hidden="true" size={12} strokeWidth={2.5} />
              ) : (
                <ChevronDown
                  aria-hidden="true"
                  className={cn("transition-transform", customVisible && "rotate-180")}
                  size={12}
                />
              )}
            </button>
          </div>
        )}

        {/* ── Custom (expandable) ─────────────────────────────────────────── */}
        {(customVisible || presets.length === 0) && (
          <div className="space-y-3 border-t border-border/40 px-3 py-3">
            {/* Single "Every [N] [Unit ▾]" row */}
            <div className="flex items-center gap-1.5 text-xs text-foreground/80">
              <span>Every</span>
              <input
                aria-label="Recurrence interval"
                className="w-8 rounded border border-border/60 bg-transparent py-0.5 text-center text-xs text-foreground transition-colors outline-none focus:border-primary/60"
                inputMode="numeric"
                onBlur={handleIntervalCommit}
                onChange={(event) =>
                  setIntervalDraft(event.target.value.replace(/\D/g, "").slice(0, 3))
                }
                onFocus={() => {
                  setIntervalDraft(String(options?.interval ?? 1));
                  setIntervalFocused(true);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    handleIntervalCommit();
                    event.currentTarget.blur();
                  }
                  if (event.key === "Escape") {
                    setIntervalDraft("");
                    setIntervalFocused(false);
                    event.currentTarget.blur();
                  }
                }}
                value={intervalDisplay}
              />

              {/* Unit dropdown */}
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
                        onClick={() => handleSelectFreq(freq)}
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

            {/* BYDAY pills — weekly only */}
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
                      onClick={() => handleToggleWeekday(value)}
                      type="button"
                    >
                      {short}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* ── Ends ────────────────────────────────────────────────────────── */}
        {hasRule && (
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
                    onClick={() => handleSelectEnd(t)}
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
                        setUntilViewMonth(0);
                        setUntilViewYear((y) => y + 1);
                      } else {
                        setUntilViewMonth((m) => m + 1);
                      }
                    }}
                    onPrev={() => {
                      if (untilViewMonth === 0) {
                        setUntilViewMonth(11);
                        setUntilViewYear((y) => y - 1);
                      } else {
                        setUntilViewMonth((m) => m - 1);
                      }
                    }}
                    onSelect={handleUntilSelect}
                    selectedDate={options.until ? parseLocalISO(options.until) : null}
                    weekStartsOn={weekStart}
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
                  onBlur={handleCountCommit}
                  onChange={(event) =>
                    setCountDraft(event.target.value.replace(/\D/g, "").slice(0, 4))
                  }
                  onFocus={() => {
                    // Blank the display on focus so typing replaces, not appends —
                    // prevents the Google iOS "8" → "18" trap.
                    setCountDraft("");
                    setCountFocused(true);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      handleCountCommit();
                      event.currentTarget.blur();
                    }
                    if (event.key === "Escape") {
                      setCountDraft("");
                      setCountFocused(false);
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
        )}

        {/* ── Preview + Stop repeating ────────────────────────────────────── */}
        {hasRule && rrule && !activePreset && (
          <div className="border-t border-border/40 bg-muted/20 px-3 py-2">
            <p className="text-xs text-foreground/55 first-letter:uppercase">
              {rruleToLabel(rrule)}
            </p>
          </div>
        )}

        {hasRule && (
          <div className="border-t border-border/40 px-3 py-2">
            <button
              className="text-xs text-foreground/55 transition-colors hover:text-destructive"
              onClick={() => {
                onChange(null);
                setOpen(false);
              }}
              type="button"
            >
              Stop repeating
            </button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
