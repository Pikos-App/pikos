// DateSchedulePopover — page-bound scheduling chip for the MetadataHeader byline.
// Thin feature-component wrapper around the shared DateTimePicker.

import type { Page } from "@pikos/core";

import {
  computeScheduleTransition,
  normalizeEndInput,
} from "@/features/calendar/utils/calendarUtils";
import { DateTimePicker } from "@/shared/components/DateTimePicker";
import { useWorkspace } from "@/shared/context/WorkspaceContext";

interface DateSchedulePopoverProps {
  page: Page;
}

export function DateSchedulePopover({ page }: DateSchedulePopoverProps) {
  const { clearSchedule, scheduleOnce } = useWorkspace();

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

  return (
    <DateTimePicker
      endValue={page.scheduledEnd ?? null}
      isDone={page.status === "done"}
      onChange={handleDateChange}
      onEndChange={handleEndChange}
      value={page.scheduledStart ?? null}
    />
  );
}
