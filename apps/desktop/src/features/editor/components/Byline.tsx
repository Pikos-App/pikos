import type { Folder, Page, PagePriority, PageStatus } from "@pikos/core";
import { isDone, isTimedIso, rruleToLabel, syncedScheduleLabel } from "@pikos/core";
import { CalendarDays, CalendarSync } from "lucide-react";

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { KeyboardShortcut } from "@/shared/components/KeyboardShortcut";
import { type MetadataChip, PageMetadataChips } from "@/shared/components/PageMetadataChips";
import { usePages } from "@/shared/context/PagesContext";

import { useBacklinks } from "../hooks/useBacklinks";
import { BacklinksButton } from "./BacklinksButton";
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
}

export function Byline({
  allTags,
  folders,
  onFolderChange,
  onOpenInCalendar,
  onPriorityChange,
  onRecurrenceChange,
  onStatusChange,
  onTagToggle,
  page,
}: BylineProps) {
  const done = isDone(page);
  const { recurrenceRules } = usePages();
  const recurrenceRule = recurrenceRules.find((r) => r.pageId === page.id);
  const backlinks = useBacklinks(page.id);
  const hasBacklinks = backlinks.length > 0;

  // Synced events lock title, folder, schedule and recurrence to the mirror; the rest stays editable.
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
            <span className="max-w-[calc(140px*var(--ui-text-scale,1))] truncate">
              {calendarName}
            </span>
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
    // Wraps rather than clips, so a large interface size can't push the folder off first. Source
    // order is the ranking: status, folder and date hold the first line, tags move down.
    <div
      aria-label="Page properties"
      className="type-ui-sm flex flex-wrap items-center gap-ui-md pt-2 pb-4 text-subtle"
      role="group"
    >
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
              // A timed page reminds on a lead time; an all-day page has no start to count back
              // from, so it offers the day-before anchor. Reminders stay editable on every synced
              // event because occurrences fire per-occurrence.
              !!page.scheduledStart && {
                kind: "reminder",
                props: { allDay: !isTimedIso(page.scheduledStart), pageId: page.id },
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
          hasBacklinks && {
            chips: [
              {
                id: "backlinks",
                kind: "node",
                node: <BacklinksButton backlinks={backlinks} />,
              },
            ],
            key: "backlinks",
          },
        ]}
        layout="byline"
      />
    </div>
  );
}
