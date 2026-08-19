import type { Folder, Page, PagePriority, PageStatus } from "@pikos/core";
import { isDone, isTimedIso, rruleToLabel } from "@pikos/core";
import { AlertTriangle, CalendarDays, CalendarSync } from "lucide-react";

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { KeyboardShortcut } from "@/shared/components/KeyboardShortcut";
import { type MetadataChip, PageMetadataChips } from "@/shared/components/PageMetadataChips";
import { usePages } from "@/shared/context/PagesContext";
import { syncedScheduleLabel } from "@/shared/utils/syncedScheduleLabel";

import { DateSchedulePopover } from "./DateSchedulePopover";

interface BylineProps {
  page: Page;
  folders: Folder[];
  allTags: string[];
  onStatusChange: (status: PageStatus) => void;
  onFolderChange: (folderId: string | null) => void;
  onPriorityChange: (priority: PagePriority) => void;
  onTagToggle: (name: string) => void;
  onRecurrenceChange: (rrule: string | null) => void;
  onOpenInCalendar?: () => void;
  saveError?: string | null;
  onErrorClick?: () => void;
}

export function Byline({
  allTags,
  folders,
  onErrorClick,
  onFolderChange,
  onOpenInCalendar,
  onPriorityChange,
  onRecurrenceChange,
  onStatusChange,
  onTagToggle,
  page,
  saveError,
}: BylineProps) {
  const done = isDone(page);
  const { recurrenceRules } = usePages();
  const recurrenceRule = recurrenceRules.find((r) => r.pageId === page.id);

  // Synced events lock title, folder placement, schedule, and recurrence to the
  // mirror; body, status, reminders, priority, and tags stay user-editable.
  const locked = page.scheduleLocked;
  const calendarName = folders.find((f) => f.id === page.folderId)?.name ?? "Calendar";
  const lockedSchedule = locked ? syncedScheduleLabel(page) : null;
  const lockedRecurrenceLabel =
    locked && recurrenceRule ? rruleToLabel(recurrenceRule.rrule) : null;

  const folderChip: MetadataChip = locked
    ? {
        id: "calendar",
        kind: "node",
        node: (
          <span className="inline-flex min-w-0 cursor-default items-center gap-1 text-subtle">
            <CalendarSync aria-hidden="true" className="shrink-0" size={13} />
            <span className="max-w-[140px] truncate">{calendarName}</span>
          </span>
        ),
      }
    : { kind: "folder", props: { folders, onChange: onFolderChange, value: page.folderId } };

  const scheduleChip: MetadataChip | null = locked
    ? lockedSchedule
      ? {
          id: "schedule",
          kind: "node",
          node: (
            <span aria-label={`Scheduled: ${lockedSchedule}`} className="cursor-default">
              {lockedSchedule}
            </span>
          ),
        }
      : null
    : { id: "schedule", kind: "node", node: <DateSchedulePopover page={page} /> };

  const recurrenceChip: MetadataChip | null = locked
    ? lockedRecurrenceLabel
      ? {
          id: "recurrence",
          kind: "node",
          node: (
            <span className="cursor-default truncate text-subtle">{lockedRecurrenceLabel}</span>
          ),
        }
      : null
    : {
        kind: "recurrence",
        props: {
          anchorDate: page.scheduledStart ?? null,
          onChange: onRecurrenceChange,
          rrule: recurrenceRule?.rrule ?? null,
          variant: "icon",
        },
      };

  return (
    <div className="type-ui-sm flex items-center gap-2 overflow-hidden pt-2 pb-4 text-subtle">
      <PageMetadataChips
        groups={[
          {
            chips: [
              {
                kind: "status",
                props: {
                  checked: done,
                  onToggle: () => onStatusChange(done ? "not_started" : "done"),
                },
              },
            ],
            key: "status",
          },
          { chips: [folderChip], key: "folder" },
          {
            boxed: true,
            chips: [
              scheduleChip,
              // Reminders only apply to timed events — all-day schedules have no
              // start time to fire "minutes before" against, so the scheduler
              // ignores them (see notifications/scheduler). Hide the bell to match.
              // Reminders stay user-editable on every synced event, one-off or
              // recurring, since synced occurrences now fire per-occurrence.
              !!page.scheduledStart &&
                isTimedIso(page.scheduledStart) && {
                  kind: "reminder",
                  props: { pageId: page.id },
                },
              recurrenceChip,
              onOpenInCalendar && {
                id: "open-in-calendar",
                kind: "node",
                node: (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        aria-label="View in calendar"
                        className="inline-flex items-center rounded transition-colors hover:text-muted-foreground focus:outline-none"
                        onClick={onOpenInCalendar}
                      >
                        <CalendarDays size={13} />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom">
                      <span className="inline-flex items-center gap-1.5">
                        View in calendar <KeyboardShortcut shortcut="mod+shift+c" />
                      </span>
                    </TooltipContent>
                  </Tooltip>
                ),
              },
            ],
            key: "schedule",
          },
          {
            chips: [
              {
                kind: "priority",
                props: { onSelect: onPriorityChange, priority: page.priority, variant: "byline" },
              },
            ],
            key: "priority",
          },
          {
            chips: [
              { kind: "tags", props: { allTags, onToggle: onTagToggle, selected: page.tags } },
            ],
            key: "tags",
          },
          saveError != null && {
            chips: [
              {
                id: "save-error",
                kind: "node",
                node: (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        aria-label="Save failed — click to retry"
                        className="inline-flex items-center gap-1 rounded text-amber-500/70 transition-colors hover:text-amber-500 focus:outline-none"
                        onClick={onErrorClick}
                      >
                        <AlertTriangle size={12} strokeWidth={2} />
                        <span>Not saved</span>
                      </button>
                    </TooltipTrigger>
                    <TooltipContent className="max-w-[260px]" side="bottom">
                      {saveError}
                    </TooltipContent>
                  </Tooltip>
                ),
              },
            ],
            key: "save-error",
          },
        ]}
        layout="byline"
      />
    </div>
  );
}
