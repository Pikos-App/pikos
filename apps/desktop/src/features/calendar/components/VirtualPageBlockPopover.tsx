import type { VirtualOccurrence } from "@pikos/core";
import { isDone } from "@pikos/core";
import { CalendarX, ExternalLink } from "lucide-react";

import { DateTimePicker } from "@/shared/components/DateTimePicker";
import { RecurrencePopover } from "@/shared/components/RecurrencePopover";
import { TaskCheckbox } from "@/shared/components/TaskCheckbox";
import { TooltipIconButton } from "@/shared/components/TooltipIconButton";
import { PRIORITY_LABELS } from "@/shared/constants/priorities";
import { usePages } from "@/shared/context/PagesContext";
import { useUI } from "@/shared/context/UIContext";
import { useRecurringStatusToggle } from "@/shared/hooks/useRecurringStatusToggle";
import { useKeyboardScope, useKeyboardShortcut } from "@/shared/keyboard/useKeyboard";
import { normalizeEndInput } from "@/shared/utils/schedule";
import { syncedScheduleLabel } from "@/shared/utils/syncedScheduleLabel";

interface VirtualPageBlockPopoverProps {
  page: VirtualOccurrence;
  onClose?: () => void;
  onDelete: () => void;
}

/**
 * Metadata popover for virtual rrule occurrences. Rows follow
 * PageBlockPopover's order (Status, Folder, Date, Repeats, Priority) but only
 * render when populated — empty rows would just add noise. Status appears only
 * on a synced-origin occurrence, which resolves per instance; a native virtual
 * has no status of its own, since its completions funnel to the head.
 * Everything except Date
 * is read-only: a virtual is just an rrule expansion of the head, so editing
 * Folder/Priority would silently mutate every occurrence — picking a new Date
 * materialises a per-occurrence override instead. On a synced series the Date is
 * read-only too — the backend rejects the reschedule, so a picker could only
 * produce an error.
 */
export function VirtualPageBlockPopover({ onClose, onDelete, page }: VirtualPageBlockPopoverProps) {
  const { folders, recurrenceRules, rescheduleVirtualOccurrence } = usePages();
  const { openPage } = useUI();
  const togglePageStatus = useRecurringStatusToggle();

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
  useKeyboardShortcut("Mod+Backspace", () => onDelete(), { scope: "modal" });
  useKeyboardShortcut("Mod+Shift+Backspace", () => onDelete(), {
    allowInInputs: true,
    preventDefault: true,
    scope: "modal",
  });

  const rule = recurrenceRules.find((r) => r.id === page.ruleId);
  const folder = folders.find((f) => f.id === page.folderId);
  const locked = page.scheduleLocked;
  const lockedSchedule = locked ? syncedScheduleLabel(page) : null;
  const completable = !!page.syncState;

  function handleStatusToggle() {
    togglePageStatus(page, "done");
    onClose?.();
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm font-medium text-foreground">{page.title || "Untitled"}</p>

      <div className="flex flex-col gap-2">
        {completable && (
          <div className="flex items-center gap-3">
            <span className="w-14 shrink-0 text-xs text-muted-foreground/50">Status</span>
            <button
              aria-label="Mark done"
              className="group/status inline-flex items-center gap-1.5 rounded text-sm text-muted-foreground transition-colors hover:text-foreground focus:outline-none"
              onClick={handleStatusToggle}
            >
              <TaskCheckbox
                as="span"
                checked={false}
                className="group-hover/status:border-foreground/60"
                onChange={handleStatusToggle}
              />
              <span>Open</span>
            </button>
          </div>
        )}

        {folder && (
          <div className="flex items-center gap-3">
            <span className="w-14 shrink-0 text-xs text-muted-foreground/50">Folder</span>
            <span className="text-sm text-muted-foreground">{folder.name}</span>
          </div>
        )}

        <div className="flex items-center gap-3">
          <span className="w-14 shrink-0 text-xs text-muted-foreground/50">Date</span>
          {locked ? (
            lockedSchedule && (
              <span className="text-sm text-muted-foreground">{lockedSchedule}</span>
            )
          ) : (
            <DateTimePicker
              endValue={page.scheduledEnd ?? null}
              isDone={isDone(page)}
              onChange={handleDateChange}
              onEndChange={handleEndChange}
              value={page.scheduledStart ?? null}
            />
          )}
        </div>

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

        {page.priority > 0 && (
          <div className="flex items-center gap-3">
            <span className="w-14 shrink-0 text-xs text-muted-foreground/50">Priority</span>
            <span className="text-sm text-muted-foreground">
              {PRIORITY_LABELS[page.priority] ?? "None"}
            </span>
          </div>
        )}
      </div>

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
            label={locked ? "Remove this occurrence from Pikos" : "Delete this occurrence"}
            onClick={onDelete}
            shortcut="mod+backspace"
          />
        </div>
      </div>
    </div>
  );
}
