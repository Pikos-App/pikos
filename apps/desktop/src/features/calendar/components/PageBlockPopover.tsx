// PageBlockPopover — metadata inspector popover for calendar blocks.
// Opens on single click. Does NOT set activePageId (calendar context preserved).
// "Open page" button is the bridge to full editor.

import type { PagePriority, PageStatus, PageSummary } from "@pikos/core";
import { formatLocalISO, nowLocalISO, parseLocalISO } from "@pikos/core";
import { CalendarX, ExternalLink, Trash2 } from "lucide-react";
import { useState } from "react";

import { FolderChip, PriorityDropdown } from "@/features/pages";
import { DateTimePicker } from "@/shared/components/DateTimePicker";
import { ReminderDropdown } from "@/shared/components/ReminderDropdown";
import { TaskCheckbox } from "@/shared/components/TaskCheckbox";
import { TooltipIconButton } from "@/shared/components/TooltipIconButton";
import { useUI } from "@/shared/context/UIContext";
import { useWorkspace } from "@/shared/context/WorkspaceContext";
import { useKeyboardScope, useKeyboardShortcut } from "@/shared/keyboard/useKeyboard";

interface PageBlockPopoverProps {
  page: PageSummary;
  onClose?: () => void;
  onDelete?: () => void;
  onRemoveDate?: () => void;
}

export function PageBlockPopover({ onClose, onDelete, onRemoveDate, page }: PageBlockPopoverProps) {
  const {
    clearSchedule,
    completeRecurringPage,
    folders,
    recurrenceRules,
    scheduleOnce,
    updatePage,
  } = useWorkspace();
  const { openPage } = useUI();

  useKeyboardScope("modal");
  useKeyboardShortcut("Mod+Backspace", () => onDelete?.(), { scope: "modal" });

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

  const isDone = page.status === "done";

  function handleStatusToggle() {
    const newStatus: PageStatus = isDone ? "not_started" : "done";
    if (newStatus === "done" && recurrenceRules.some((r) => r.pageId === page.id)) {
      void completeRecurringPage(page.id);
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
    // Preserve duration when shifting start time on a timed event.
    let endIso = page.scheduledEnd ?? undefined;
    if (
      iso.includes("T") &&
      page.scheduledStart?.includes("T") &&
      page.scheduledEnd?.includes("T")
    ) {
      const durationMs =
        parseLocalISO(page.scheduledEnd).getTime() - parseLocalISO(page.scheduledStart).getTime();
      if (durationMs > 0) {
        endIso = formatLocalISO(new Date(parseLocalISO(iso).getTime() + durationMs));
      }
    }
    void scheduleOnce(page.id, iso, endIso);
  }

  function handleEndChange(endIso: string | null) {
    if (page.scheduledStart) {
      void scheduleOnce(page.id, page.scheduledStart, endIso ?? undefined);
    }
  }

  function handleOpenPage(e: React.MouseEvent) {
    e.stopPropagation();
    openPage(page.id);
  }

  return (
    <div className="flex flex-col gap-3">
      {/* Title */}
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

      {/* Metadata rows */}
      <div className="flex flex-col gap-2">
        {/* Status */}
        <div className="flex items-center gap-3">
          <span className="w-14 shrink-0 text-xs text-muted-foreground/50">Status</span>
          <button
            aria-label={isDone ? "Mark not done" : "Mark done"}
            className="group/status inline-flex items-center gap-1.5 rounded text-sm text-muted-foreground transition-colors hover:text-foreground focus:outline-none"
            onClick={handleStatusToggle}
          >
            <TaskCheckbox
              as="span"
              checked={isDone}
              className={!isDone ? "group-hover/status:border-foreground/60" : undefined}
              onChange={handleStatusToggle}
            />
            <span>{isDone ? "Done" : "Open"}</span>
          </button>
        </div>

        {/* Folder */}
        <div className="flex items-center gap-3">
          <span className="w-14 shrink-0 text-xs text-muted-foreground/50">Folder</span>
          <FolderChip folders={folders} onChange={handleFolderChange} value={page.folderId} />
        </div>

        {/* Date / time + reminder bell */}
        <div className="flex items-center gap-3">
          <span className="w-14 shrink-0 text-xs text-muted-foreground/50">Date</span>
          <div className="flex items-center gap-2">
            <DateTimePicker
              endValue={page.scheduledEnd ?? null}
              isDone={isDone}
              onChange={handleDateChange}
              onEndChange={handleEndChange}
              value={page.scheduledStart ?? null}
            />
            {page.scheduledStart && <ReminderDropdown iconSize={12} pageId={page.id} />}
          </div>
        </div>

        {/* Priority */}
        <div className="flex items-center gap-3">
          <span className="w-14 shrink-0 text-xs text-muted-foreground/50">Priority</span>
          <PriorityDropdown
            onSelect={handlePriorityChange}
            priority={page.priority}
            variant="byline"
          />
        </div>
      </div>

      {/* Open page / actions */}
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
