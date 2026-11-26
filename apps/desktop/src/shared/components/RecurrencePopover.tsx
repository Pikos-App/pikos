import {
  buildRrule,
  formatDateOnly,
  optionsForFreq,
  optionsWithEnd,
  parseLocalISO,
  parseRrule,
  type RecurrenceFreq,
  type RecurrenceOptions,
  type RecurrenceWeekday,
  rruleEditWouldDegrade,
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
import { useNow } from "@/shared/hooks/useNow";

import { type AnchoredOpen, PickerTrigger } from "./PickerTrigger";
import { computePresets, type Preset, shapesMatch } from "./recurrence/recurrenceConstants";
import { RecurrenceCustomEditor } from "./recurrence/RecurrenceCustomEditor";
import { RecurrenceEndsEditor, type RecurrenceEndType } from "./recurrence/RecurrenceEndsEditor";
import { RecurrencePresetList } from "./recurrence/RecurrencePresetList";

export interface RecurrencePopoverProps {
  rrule: string | null;
  onChange: (rrule: string | null) => void;
  /** ISO start date of the anchor occurrence, used for contextual preset labels. When absent,
   * presets are hidden and only Custom controls appear. */
  anchorDate?: string | null;
  disabled?: boolean;
  readOnly?: boolean;
  disabledHint?: string;
  /** "compact" is icon-only with no rule or override and icon plus short label when set, so the
   * empty state is unobtrusive; "icon" adds a hover tooltip. */
  variant?: "icon" | "label" | "compact";
  /** External label shown next to the icon when no rrule is set, such as an NLP preview like "3 occurrences". */
  overrideLabel?: string;
  onClose?: () => void;
  anchored?: AnchoredOpen;
}

/** The month the Ends calendar first shows: the rule's end date, else this month. */
function initialUntilView(rrule: string | null): Date {
  const until = rrule ? parseRrule(rrule)?.until : undefined;
  return until ? parseLocalISO(until) : new Date();
}

function formatTriggerLabel(rrule: string | null, short: boolean): string {
  if (!rrule) return "Does not repeat";
  return short ? rruleToShortLabel(rrule) : rruleToLabel(rrule);
}

export function RecurrencePopover({
  anchorDate,
  anchored,
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
  const [ownOpen, setOwnOpen] = useState(false);
  const open = anchored !== undefined || ownOpen;
  const [customManuallyExpanded, setCustomManuallyExpanded] = useState(false);
  const [untilViewYear, setUntilViewYear] = useState(() => initialUntilView(rrule).getFullYear());
  const [untilViewMonth, setUntilViewMonth] = useState(() => initialUntilView(rrule).getMonth());
  const now = useNow();

  // Draft state for numeric inputs: emits only on commit (blur/Enter), so keystrokes never emit
  // invalid rrules.
  const [countDraft, setCountDraft] = useState<string>("");
  const [intervalDraft, setIntervalDraft] = useState<string>("");
  const [intervalFocused, setIntervalFocused] = useState(false);
  const [countFocused, setCountFocused] = useState(false);

  const options = rrule ? parseRrule(rrule) : null;
  const hasRule = options !== null;
  const degradeLocked = !!rrule && rruleEditWouldDegrade(rrule);
  const effectiveReadOnly = readOnly || degradeLocked;
  const triggerLabel = hasRule
    ? formatTriggerLabel(rrule, /* short */ true)
    : (overrideLabel ?? formatTriggerLabel(rrule, /* short */ true));
  // Screen readers don't see the adjacent date chip that visually conveys
  // BYDAY, so the aria-label carries the full cadence ("every week on
  // Monday") even when the visible text is the short "Weekly".
  const ariaTriggerLabel = hasRule
    ? formatTriggerLabel(rrule, /* short */ false)
    : (overrideLabel ?? formatTriggerLabel(rrule, /* short */ false));

  const anchor = anchorDate ? parseLocalISO(anchorDate) : now;
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
    const merged: RecurrenceOptions = { ...shape };
    if (options?.count != null) merged.count = options.count;
    else if (options?.until) merged.until = options.until;
    return merged;
  }

  function handleSelectPreset(preset: Preset) {
    setCustomManuallyExpanded(false);
    // Re-clicking the active preset must not re-emit: the head's rule update
    // triggers a backend recompute for an identical rule.
    if (options && shapesMatch(options, preset.options)) return;
    emit(withEndCondition(preset.options));
  }

  function handleToggleCustom() {
    if (isCustomShape) return;
    setCustomManuallyExpanded((prev) => !prev);
  }

  function handleSelectFreq(freq: RecurrenceFreq) {
    // Re-clicking the current freq must be a no-op: optionsForFreq whitelists per
    // freq, so a re-emit strips the BY* terms that freq can't carry — a monthly
    // "every Friday" rule would lose its BYDAY and become monthly-on-the-anchor.
    if (freq === options?.freq) return;
    emit(options ? optionsForFreq(options, freq) : { freq, interval: 1 });
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
    delete nextOpts.byweekdayOrdinals;
    if (sorted.length === 0) delete nextOpts.byweekday;
    else nextOpts.byweekday = sorted;
    emit(nextOpts);
  }

  function handleSelectEnd(type: RecurrenceEndType) {
    if (!options) return;
    if (type === "until") {
      const until = options.until ?? format(addMonths(new Date(), 3), "yyyy-MM-dd");
      emit(optionsWithEnd(options, { until }));
    } else if (type === "count") {
      emit(optionsWithEnd(options, { count: options.count ?? 10 }));
    } else {
      emit(optionsWithEnd(options, null));
    }
  }

  function handleUntilSelect(date: Date) {
    if (!options) return;
    emit(optionsWithEnd(options, { until: formatDateOnly(date) }));
  }

  function handleCountCommit() {
    setCountFocused(false);
    if (!options) {
      setCountDraft("");
      return;
    }
    const parsed = parseInt(countDraft, 10);
    if (!isNaN(parsed) && parsed > 0) emit(optionsWithEnd(options, { count: parsed }));
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
    if (effectiveReadOnly || disabled) return;
    if (!next) {
      setCountDraft("");
      setIntervalDraft("");
      setIntervalFocused(false);
      setCountFocused(false);
      setCustomManuallyExpanded(false);
      anchored?.onClose();
    } else if (options?.until) {
      const d = parseLocalISO(options.until);
      setUntilViewYear(d.getFullYear());
      setUntilViewMonth(d.getMonth());
    }
    setOwnOpen(next);
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
    : degradeLocked
      ? "This repeat can't be edited here"
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
          : // In label mode the chip may shrink inside a bounded flex row; the label truncates, the
            // icon never shrinks.
            "min-w-0 text-sm",
        disabled
          ? "cursor-not-allowed text-muted-foreground/30"
          : effectiveReadOnly
            ? // A button's default pointer cursor on a chip that refuses the edit offers something it
              // will not do.
              "cursor-default text-muted-foreground"
            : hasLabelContent
              ? "text-muted-foreground hover:text-foreground"
              : "text-subtle hover:text-muted-foreground"
      )}
      type="button"
    >
      <Repeat2 aria-hidden="true" className="shrink-0" size={13} />
      {showLabel && <span className="truncate">{triggerLabel}</span>}
    </button>
  );

  if (disabled || effectiveReadOnly) {
    // Degrade-locked chips get a tooltip even in label mode so the disabled edit has an
    // explanation.
    if (isIconOnly || degradeLocked) {
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
      {anchored ? (
        <PickerTrigger anchored={anchored}>{triggerButton}</PickerTrigger>
      ) : isIconOnly ? (
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
            <p className="text-xs text-subtle first-letter:uppercase">{rruleToLabel(rrule)}</p>
          </div>
        )}

        {hasRule && (
          <div className="border-t border-border/40 px-3 py-2">
            <button
              className="text-xs text-subtle transition-colors hover:text-destructive"
              onClick={() => {
                onChange(null);
                handleOpenChange(false);
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
