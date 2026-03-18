// DateSchedulePopover — page-bound scheduling chip for the MetadataHeader byline.
// Thin feature-component wrapper around the shared DateTimePicker.

import { useWorkspace } from "@/shared/context/WorkspaceContext";
import { DateTimePicker } from "@/shared/components/DateTimePicker";
import type { Page } from "@pikos/core";

interface DateSchedulePopoverProps {
  page: Page;
}

export function DateSchedulePopover({ page }: DateSchedulePopoverProps) {
  const { scheduleOnce, clearSchedule } = useWorkspace();

  function handleDateChange(iso: string | null) {
    if (iso) {
      void scheduleOnce(page.id, iso, page.scheduledEnd ?? undefined);
    } else {
      void clearSchedule(page.id);
    }
  }

  function handleEndChange(endIso: string | null) {
    if (page.scheduledStart) {
      void scheduleOnce(page.id, page.scheduledStart, endIso ?? undefined);
    }
  }

  return (
    <DateTimePicker
      value={page.scheduledStart ?? null}
      onChange={handleDateChange}
      endValue={page.scheduledEnd ?? null}
      onEndChange={handleEndChange}
      isDone={page.status === "done"}
    />
  );
}
