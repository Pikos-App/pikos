import type { PagePriority, PageStatus, PageSummary } from "@pikos/core";
import { getLocalTimezone, isDone, isTimedIso, nowLocalISO, snapAnchorToRule } from "@pikos/core";
import { CalendarX, ExternalLink, Trash2 } from "lucide-react";
import { useState } from "react";

import { DateTimePicker } from "@/shared/components/DateTimePicker";
import { FolderChip } from "@/shared/components/FolderChip";
import { PriorityDropdown } from "@/shared/components/PriorityDropdown";
import { RecurrencePopover } from "@/shared/components/RecurrencePopover";
import { ReminderDropdown } from "@/shared/components/ReminderDropdown";
import { TaskCheckbox } from "@/shared/components/TaskCheckbox";
import { TooltipIconButton } from "@/shared/components/TooltipIconButton";
import { usePages } from "@/shared/context/PagesContext";
import { useRecurringCompleteDialog } from "@/shared/context/RecurringCompleteDialogContext";
import { useUI } from "@/shared/context/UIContext";
import { useKeyboardScope, useKeyboardShortcut } from "@/shared/keyboard/useKeyboard";
import { computeScheduleTransition, normalizeEndInput } from "@/shared/utils/schedule";

interface PageBlockPopoverProps {
  page: PageSummary;
  onClose?: () => void;
  onDelete?: () => void;
  onRemoveDate?: () => void;
}

/**
 * Opens on single click. Does NOT set activePageId (calendar context
 * preserved) — the "Open page" button is the bridge to the full editor.
 */
export function PageBlockPopover({ onClose, onDelete, onRemoveDate, page }: PageBlockPopoverProps) {
  const {
    clearSchedule,
    createRecurrence,
    deleteRecurrence,
    folders,
    recurrenceRules,
    scheduleOnce,
    updatePage,
    updateRecurrence,
  } = usePages();
  const { request: requestRecurringComplete } = useRecurringCompleteDialog();
  const { openPage } = useUI();

  useKeyboardScope("modal");
  useKeyboardShortcut("Mod+Backspace", () => onDelete?.(), { scope: "modal" });
  // Alias that overrides the OS line-delete inside the title input.
  useKeyboardShortcut("Mod+Shift+Backspace", () => onDelete?.(), {
    allowInInputs: true,
    preventDefault: true,
    scope: "modal",
  });

  // Local title state — popover mounts fresh on each open so no sync needed.
  const [titleValue, setTitleValue] = useState(page.title);

  // Sync every keystroke to the store (debounced write) so close paths that
  // don't run our blur handler — outside click, Escape, parent unmount — still
  // see the latest title when they check whether the page is still untitled.
  function handleTitleChange(e: React.ChangeEvent<HTMLInputElement>) {
    const next = e.target.value;
    setTitleValue(next);
    if (next !== page.title) {
      updatePage(page.id, { title: next });
    }
  }

  const done = isDone(page);

  function handleStatusToggle() {
    const newStatus: PageStatus = done ? "not_started" : "done";
    if (newStatus === "done" && recurrenceRules.some((r) => r.pageId === page.id)) {
      requestRecurringComplete(page.id);
      return;
    }
    updatePage(page.id, {
      completedAt: newStatus === "done" ? nowLocalISO() : null,
      status: newStatus,
    });
  }

  function handleTitleBlur(e: React.FocusEvent<HTMLInputElement>) {
    const value = e.currentTarget.value.trim();
    if (value !== page.title) {
      updatePage(page.id, { title: value || page.title });
    }
  }

  function handleTitleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      e.preventDefault();
      const value = e.currentTarget.value.trim();
      const nextTitle = value || "Untitled";
      if (nextTitle !== page.title) {
        updatePage(page.id, { title: nextTitle });
      }
      onClose?.();
    }
  }

  function handlePriorityChange(priority: PagePriority) {
    updatePage(page.id, { priority });
  }

  function handleFolderChange(folderId: string | null) {
    updatePage(page.id, { folderId });
  }

  function handleDateChange(iso: string | null) {
    if (!iso) {
      void clearSchedule(page.id);
      return;
    }
    const { end, start } = computeScheduleTransition(
      { end: page.scheduledEnd, start: page.scheduledStart },
      iso
    );
    void scheduleOnce(page.id, start, end);
  }

  function handleEndChange(endIso: string | null) {
    if (!page.scheduledStart) return;
    const next = normalizeEndInput(page.scheduledStart, endIso);
    void scheduleOnce(page.id, page.scheduledStart, next);
  }

  async function handleRecurrenceChange(rrule: string | null) {
    const existing = recurrenceRules.find((r) => r.pageId === page.id);
    if (!rrule) {
      if (existing) await deleteRecurrence(existing.id);
      return;
    }
    if (existing) {
      await updateRecurrence(existing.id, { rrule });
      // Snap the head onto the first date the (possibly re-dayed) rule permits
      // so no stray "first run" lingers on an excluded weekday.
      const snapped = snapAnchorToRule(rrule, existing.scheduledStart);
      if (snapped !== existing.scheduledStart) {
        await scheduleOnce(page.id, snapped, page.scheduledEnd ?? undefined);
      }
      return;
    }
    if (!page.scheduledStart) return;
    // Snap the anchor onto the first permitted occurrence (e.g. a Sunday date
    // under an M/W/F rule moves to Monday) before anchoring the rule there.
    const anchorStart = snapAnchorToRule(rrule, page.scheduledStart);
    if (anchorStart !== page.scheduledStart) {
      await scheduleOnce(page.id, anchorStart, page.scheduledEnd ?? undefined);
    }
    const tz = getLocalTimezone();
    await createRecurrence({
      pageId: page.id,
      rrule,
      scheduledStart: anchorStart,
      ...(page.scheduledEnd ? { scheduledEnd: page.scheduledEnd } : {}),
      timezone: tz,
    });
  }

  const recurrenceRule = recurrenceRules.find((r) => r.pageId === page.id);

  function handleOpenPage(e: React.MouseEvent) {
    e.stopPropagation();
    openPage(page.id);
    onClose?.();
  }

  return (
    <div className="flex flex-col gap-3">
      <input
        autoFocus
        className="w-full border-0 bg-transparent text-sm font-medium text-foreground outline-none placeholder:text-muted-foreground/40"
        onBlur={handleTitleBlur}
        onChange={handleTitleChange}
        onFocus={(e) => {
          const el = e.currentTarget;
          requestAnimationFrame(() => el.setSelectionRange(el.value.length, el.value.length));
        }}
        onKeyDown={handleTitleKeyDown}
        placeholder="Untitled"
        value={titleValue}
      />

      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-3">
          <span className="w-14 shrink-0 text-xs text-muted-foreground/50">Status</span>
          <button
            aria-label={done ? "Mark not done" : "Mark done"}
            className="group/status inline-flex items-center gap-1.5 rounded text-sm text-muted-foreground transition-colors hover:text-foreground focus:outline-none"
            onClick={handleStatusToggle}
          >
            <TaskCheckbox
              as="span"
              checked={done}
              className={!done ? "group-hover/status:border-foreground/60" : undefined}
              onChange={handleStatusToggle}
            />
            <span>{done ? "Done" : "Open"}</span>
          </button>
        </div>

        <div className="flex items-center gap-3">
          <span className="w-14 shrink-0 text-xs text-muted-foreground/50">Folder</span>
          <FolderChip folders={folders} onChange={handleFolderChange} value={page.folderId} />
        </div>

        <div className="flex items-center gap-3">
          <span className="w-14 shrink-0 text-xs text-muted-foreground/50">Date</span>
          <div className="flex items-center gap-2">
            <DateTimePicker
              endValue={page.scheduledEnd ?? null}
              isDone={done}
              onChange={handleDateChange}
              onEndChange={handleEndChange}
              value={page.scheduledStart ?? null}
            />
            {/* Timed events only — all-day schedules don't fire reminders, so
                hide the bell (matches notifications/scheduler behaviour). */}
            {page.scheduledStart && isTimedIso(page.scheduledStart) && (
              <ReminderDropdown iconSize={12} pageId={page.id} />
            )}
          </div>
        </div>

        <div className="flex items-center gap-3">
          <span className="w-14 shrink-0 text-xs text-muted-foreground/50">Repeats</span>
          <RecurrencePopover
            anchorDate={page.scheduledStart ?? null}
            onChange={(rrule) => void handleRecurrenceChange(rrule)}
            rrule={recurrenceRule?.rrule ?? null}
          />
        </div>

        <div className="flex items-center gap-3">
          <span className="w-14 shrink-0 text-xs text-muted-foreground/50">Priority</span>
          <PriorityDropdown
            onSelect={handlePriorityChange}
            priority={page.priority}
            variant="byline"
          />
        </div>
      </div>

      <div className="flex items-center justify-between border-t border-border/40 pt-1">
        <button
          className="inline-flex items-center gap-1.5 text-xs text-muted-foreground/60 transition-colors hover:text-foreground focus:outline-none"
          onClick={handleOpenPage}
        >
          <ExternalLink size={11} />
          Open page
        </button>
        <div className="flex items-center gap-2">
          {onRemoveDate && page.scheduledStart && (
            <TooltipIconButton
              className="inline-flex items-center gap-1 text-xs text-muted-foreground/40 transition-colors hover:text-foreground focus:outline-none"
              icon={<CalendarX size={11} />}
              label="Remove date"
              onClick={() => {
                void clearSchedule(page.id);
                onRemoveDate();
              }}
            />
          )}
          {onDelete && (
            <TooltipIconButton
              className="inline-flex items-center gap-1 text-xs text-muted-foreground/40 transition-colors hover:text-destructive focus:outline-none"
              icon={<Trash2 size={11} />}
              label="Delete page"
              onClick={onDelete}
              shortcut="mod+backspace"
            />
          )}
        </div>
      </div>
    </div>
  );
}
