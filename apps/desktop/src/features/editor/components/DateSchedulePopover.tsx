// DateSchedulePopover — page-bound scheduling chip for the MetadataHeader byline.
// Thin feature-component wrapper around the shared DateTimePicker.

import { useWorkspace } from "@/shared/context/WorkspaceContext";
import { DateTimePicker } from "@/shared/components/DateTimePicker";
import type { Page } from "@pikos/core";

interface DateSchedulePopoverProps {
  page: Page;
}

export function DateSchedulePopover({ page }: DateSchedulePopoverProps) {
  const { scheduleOnce, clearSchedule, updatePage } = useWorkspace();

  function handleDateChange(iso: string | null) {
    if (iso) {
      void scheduleOnce(page.id, iso);
    } else {
      void clearSchedule(page.id);
    }
  }

  function handleDurationChange(minutes: number | null) {
    updatePage(page.id, { durationMinutes: minutes });
  }

  return (
    <DateTimePicker
      value={page.scheduledStart ?? null}
      onChange={handleDateChange}
      durationMinutes={page.durationMinutes ?? null}
      onDurationChange={handleDurationChange}
      isDone={page.status === "done"}
    />
  );
}
