import type { VirtualOccurrence } from "@pikos/core";
import { isDone, normalizeEndInput, PRIORITY_LABELS, syncedScheduleLabel } from "@pikos/core";
import { CalendarX, ExternalLink } from "lucide-react";

import { PageMetadataChips } from "@/shared/components/PageMetadataChips";
import { TooltipIconButton } from "@/shared/components/TooltipIconButton";
import { usePages } from "@/shared/context/PagesContext";
import { useUI } from "@/shared/context/UIContext";
import { useRecurringStatusToggle } from "@/shared/hooks/useRecurringStatusToggle";
import { useKeyboardScope } from "@/shared/keyboard/useKeyboard";

import { useBlockDeleteShortcut } from "../hooks/useBlockDeleteShortcut";
import { occurrenceDeleteLabel } from "../utils/occurrenceDeleteLabel";
interface VirtualPageBlockPopoverProps {
  page: VirtualOccurrence;
  onClose?: () => void;
  onDelete: () => void;
}

/**
 * Metadata popover for virtual rrule occurrences. Rows follow PageBlockPopover's order but render
 * only when populated. Status appears only on a synced-origin occurrence, which resolves per
 * instance; a native virtual has none, since its completions funnel to the head. Only Date is
 * editable: a virtual is an rrule expansion of the head, so editing Folder or Priority would
 * mutate every occurrence, while a new Date materialises a per-occurrence override. On a synced
 * series Date is read-only too, since the backend rejects the reschedule.
 */
export function VirtualPageBlockPopover({ onClose, onDelete, page }: VirtualPageBlockPopoverProps) {
  const { folders, recurrenceRules, rescheduleVirtualOccurrence } = usePages();
  const { openPage } = useUI();
  const togglePageStatus = useRecurringStatusToggle();

  // A new start materialises a page_schedules override and the virtual drops out (excluded by
  // originalDate). Close the popover so it isn't left anchored to a chip that's about to move.
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
  useBlockDeleteShortcut(onDelete);

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
        <PageMetadataChips
          groups={[
            completable && {
              chips: [{ kind: "status", props: { checked: false, onToggle: handleStatusToggle } }],
              key: "Status",
            },
            folder && {
              chips: [
                {
                  id: "folder",
                  kind: "node",
                  node: <span className="text-sm text-muted-foreground">{folder.name}</span>,
                },
              ],
              key: "Folder",
            },
            {
              chips: [
                locked
                  ? lockedSchedule
                    ? {
                        id: "schedule",
                        kind: "node",
                        node: (
                          <span className="text-sm text-muted-foreground">{lockedSchedule}</span>
                        ),
                      }
                    : null
                  : {
                      kind: "date",
                      props: {
                        endValue: page.scheduledEnd ?? null,
                        isDone: isDone(page),
                        onChange: handleDateChange,
                        onEndChange: handleEndChange,
                        value: page.scheduledStart ?? null,
                      },
                    },
              ],
              key: "Date",
            },
            rule && {
              chips: [
                {
                  kind: "recurrence",
                  props: {
                    anchorDate: rule.scheduledStart,
                    onChange: () => undefined,
                    readOnly: true,
                    rrule: rule.rrule,
                  },
                },
              ],
              key: "Repeats",
            },
            page.priority > 0 && {
              chips: [
                {
                  id: "priority",
                  kind: "node",
                  node: (
                    <span className="text-sm text-muted-foreground">
                      {PRIORITY_LABELS[page.priority] ?? "None"}
                    </span>
                  ),
                },
              ],
              key: "Priority",
            },
          ]}
          layout="rows"
        />
      </div>

      <div className="flex items-center justify-between border-t border-border/40 pt-1">
        <button
          className="inline-flex items-center gap-1.5 text-xs text-subtle transition-colors hover:text-foreground focus:outline-none"
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
            className="inline-flex items-center gap-1 text-xs text-subtle transition-colors hover:text-destructive focus:outline-none"
            icon={<CalendarX size={11} />}
            label={occurrenceDeleteLabel(locked)}
            onClick={onDelete}
            shortcut="mod+backspace"
          />
        </div>
      </div>
    </div>
  );
}
