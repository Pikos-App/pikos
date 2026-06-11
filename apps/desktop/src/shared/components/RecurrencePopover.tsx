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
import { Repeat2 } from "lucide-react";
import { useState } from "react";

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useAppSettings } from "@/shared/context/AppSettingsContext";

import { computePresets, type Preset, shapesMatch } from "./recurrence/recurrenceConstants";
import { RecurrenceCustomEditor } from "./recurrence/RecurrenceCustomEditor";
import { RecurrenceEndsEditor, type RecurrenceEndType } from "./recurrence/RecurrenceEndsEditor";
import { RecurrencePresetList } from "./recurrence/RecurrencePresetList";

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
  /** Fires when the popover transitions from open to closed (any cause). */
  onClose?: () => void;
}

function formatTriggerLabel(rrule: string | null, short: boolean): string {
  if (!rrule) return "Does not repeat";
  return short ? rruleToShortLabel(rrule) : rruleToLabel(rrule);
}

export function RecurrencePopover({
  anchorDate,
  disabled = false,
  disabledHint,
  onChange,
  onClose,
  overrideLabel,
  readOnly = false,
  rrule,
  variant = "label",
}: RecurrencePopoverProps) {
  const { weekStart } = useAppSettings();
  const [open, setOpen] = useState(false);
  const [customManuallyExpanded, setCustomManuallyExpanded] = useState(false);
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

  function handleToggleCustom() {
    if (isCustomShape) return;
    setCustomManuallyExpanded((prev) => !prev);
  }

  function handleSelectFreq(freq: RecurrenceFreq) {
    const base: RecurrenceOptions = options
      ? { ...options, freq, interval: options.interval }
      : { freq, interval: 1 };
    // BYDAY only meaningful for WEEKLY.
    if (freq !== "WEEKLY") delete base.byweekday;
    emit(base);
  }

  function handleIntervalCommit() {
    setIntervalFocused(false);
    if (!options) {
      setIntervalDraft("");
      return;
    }
    const parsed = parseInt(intervalDraft, 10);
    if (!isNaN(parsed) && parsed > 0) emit({ ...options, interval: parsed });
    setIntervalDraft("");
  }

  function handleIntervalCancel() {
    setIntervalDraft("");
    setIntervalFocused(false);
  }

  function handleIntervalFocus() {
    setIntervalDraft(String(options?.interval ?? 1));
    setIntervalFocused(true);
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

  function handleSelectEnd(type: RecurrenceEndType) {
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
  }

  function handleCountCommit() {
    setCountFocused(false);
    if (!options) {
      setCountDraft("");
      return;
    }
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

  function handleCountCancel() {
    setCountDraft("");
    setCountFocused(false);
  }

  function handleCountFocus() {
    // Blank the display on focus so typing replaces, not appends — prevents
    // the Google iOS "8" → "18" trap.
    setCountDraft("");
    setCountFocused(true);
  }

  function handleOpenChange(next: boolean) {
    if (readOnly || disabled) return;
    if (!next) {
      setCountDraft("");
      setIntervalDraft("");
      setIntervalFocused(false);
      setCountFocused(false);
      setCustomManuallyExpanded(false);
    } else if (options?.until) {
      const d = parseLocalISO(options.until);
      setUntilViewYear(d.getFullYear());
      setUntilViewMonth(d.getMonth());
    }
    setOpen(next);
  }

  const endType: RecurrenceEndType =
    options?.count != null ? "count" : options?.until ? "until" : "never";

  const intervalDisplay = intervalFocused ? intervalDraft : String(options?.interval ?? 1);
  const countDisplay = countFocused
    ? countDraft
    : options?.count != null
      ? String(options.count)
      : "";

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

      <PopoverContent
        align="start"
        className="w-[260px] p-0"
        {...(onClose && {
          onCloseAutoFocus: (e: Event) => {
            e.preventDefault();
            onClose();
          },
        })}
      >
        <RecurrencePresetList
          activePresetId={activePreset?.id ?? null}
          customVisible={customVisible}
          isCustomShape={isCustomShape}
          onSelectPreset={handleSelectPreset}
          onToggleCustom={handleToggleCustom}
          presets={presets}
        />

        {(customVisible || presets.length === 0) && (
          <RecurrenceCustomEditor
            intervalDisplay={intervalDisplay}
            intervalFocused={intervalFocused}
            onIntervalCancel={handleIntervalCancel}
            onIntervalChange={setIntervalDraft}
            onIntervalCommit={handleIntervalCommit}
            onIntervalFocus={handleIntervalFocus}
            onSelectFreq={handleSelectFreq}
            onToggleWeekday={handleToggleWeekday}
            options={options}
          />
        )}

        {hasRule && (
          <RecurrenceEndsEditor
            countDisplay={countDisplay}
            endType={endType}
            onCountCancel={handleCountCancel}
            onCountChange={setCountDraft}
            onCountCommit={handleCountCommit}
            onCountFocus={handleCountFocus}
            onSelectEnd={handleSelectEnd}
            onUntilSelect={handleUntilSelect}
            onUntilViewMonthChange={setUntilViewMonth}
            onUntilViewYearChange={setUntilViewYear}
            options={options}
            untilViewMonth={untilViewMonth}
            untilViewYear={untilViewYear}
            weekStartsOn={weekStart}
          />
        )}

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
