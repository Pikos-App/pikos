// VirtualPageBlockPopover — metadata popover for virtual rrule occurrences.
// Shows page metadata; the only inline edit is the Date row, which opens a
// date/time picker. Picking a new value materialises a page_schedules
// override row keyed by (ruleId, originalDate) — the head's denorm is
// untouched. Other actions: open page, skip this occurrence.

import type { VirtualOccurrence } from "@pikos/core";
import { CalendarX, ExternalLink } from "lucide-react";

import { normalizeEndInput } from "@/features/calendar/utils/calendarUtils";
import { DateTimePicker } from "@/shared/components/DateTimePicker";
import { RecurrencePopover } from "@/shared/components/RecurrencePopover";
import { TooltipIconButton } from "@/shared/components/TooltipIconButton";
import { PRIORITY_LABELS } from "@/shared/constants/priorities";
import { useUI } from "@/shared/context/UIContext";
import { useWorkspace } from "@/shared/context/WorkspaceContext";
import { useKeyboardScope, useKeyboardShortcut } from "@/shared/keyboard/useKeyboard";

interface VirtualPageBlockPopoverProps {
  page: VirtualOccurrence;
  onClose?: () => void;
  onSkip: () => void;
}

export function VirtualPageBlockPopover({ onClose, onSkip, page }: VirtualPageBlockPopoverProps) {
  const { folders, recurrenceRules, rescheduleVirtualOccurrence } = useWorkspace();
  const { openPage } = useUI();

  // Picking a new start materialises a page_schedules override at the new
  // time. The virtual disappears (excluded by originalDate match) and the
  // override renders as a normal block. Close the popover so the user sees
  // the result instead of a popover anchored to a chip that's about to move.
  function handleDateChange(iso: string | null) {
    if (!iso) return; // clearing a virtual's date isn't meaningful — use Skip instead
    void rescheduleVirtualOccurrence(
      page.ruleId,
      page.originalDate,
      iso,
      page.scheduledEnd ?? undefined
    );
    onClose?.();
  }

  function handleEndChange(endIso: string | null) {
    if (!page.scheduledStart) return;
    const next = normalizeEndInput(page.scheduledStart, endIso);
    void rescheduleVirtualOccurrence(
      page.ruleId,
      page.originalDate,
      page.scheduledStart,
      next ?? undefined
    );
    onClose?.();
  }

  useKeyboardScope("modal");
  useKeyboardShortcut("Mod+Backspace", () => onSkip(), { scope: "modal" });

  const rule = recurrenceRules.find((r) => r.id === page.ruleId);
  const folder = folders.find((f) => f.id === page.folderId);

  return (
    <div className="flex flex-col gap-3">
      {/* Title (read-only) */}
      <p className="text-sm font-medium text-foreground">{page.title || "Untitled"}</p>

      {/* Metadata rows (read-only) */}
      <div className="flex flex-col gap-2">
        {folder && (
          <div className="flex items-center gap-3">
            <span className="w-14 shrink-0 text-xs text-muted-foreground/50">Folder</span>
            <span className="text-sm text-muted-foreground">{folder.name}</span>
          </div>
        )}

        <div className="flex items-center gap-3">
          <span className="w-14 shrink-0 text-xs text-muted-foreground/50">Date</span>
          <DateTimePicker
            endValue={page.scheduledEnd ?? null}
            isDone={page.status === "done"}
            onChange={handleDateChange}
            onEndChange={handleEndChange}
            value={page.scheduledStart ?? null}
          />
        </div>

        {page.priority > 0 && (
          <div className="flex items-center gap-3">
            <span className="w-14 shrink-0 text-xs text-muted-foreground/50">Priority</span>
            <span className="text-sm text-muted-foreground">
              {PRIORITY_LABELS[page.priority] ?? "None"}
            </span>
          </div>
        )}

        {rule && (
          <div className="flex items-center gap-3">
            <span className="w-14 shrink-0 text-xs text-muted-foreground/50">Repeats</span>
            <RecurrencePopover
              anchorDate={rule.scheduledStart}
              onChange={() => undefined}
              readOnly
              rrule={rule.rrule}
            />
          </div>
        )}
      </div>

      {/* Actions */}
      <div className="flex items-center justify-between border-t border-border/40 pt-1">
        <button
          className="inline-flex items-center gap-1.5 text-xs text-muted-foreground/60 transition-colors hover:text-foreground focus:outline-none"
          onClick={(e) => {
            e.stopPropagation();
            openPage(page.id);
            onClose?.();
          }}
        >
          <ExternalLink size={11} />
          Open page
        </button>
        <div className="flex items-center gap-2">
          <TooltipIconButton
            className="inline-flex items-center gap-1 text-xs text-muted-foreground/40 transition-colors hover:text-destructive focus:outline-none"
            icon={<CalendarX size={11} />}
            label="Skip this occurrence"
            onClick={onSkip}
            shortcut="mod+backspace"
          />
        </div>
      </div>
    </div>
  );
}
