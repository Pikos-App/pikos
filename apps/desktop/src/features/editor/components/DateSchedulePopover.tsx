// DateSchedulePopover — page-bound scheduling chip for the MetadataHeader byline.
// Thin feature-component wrapper around the shared DateTimePicker.

import type { Page } from "@pikos/core";

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
    // Preserve duration when changing start on a timed event.
    let endIso = page.scheduledEnd ?? undefined;
    if (
      iso.includes("T") &&
      page.scheduledStart?.includes("T") &&
      page.scheduledEnd?.includes("T")
    ) {
      const durationMs =
        new Date(page.scheduledEnd).getTime() - new Date(page.scheduledStart).getTime();
      if (durationMs > 0) {
        const newEnd = new Date(new Date(iso).getTime() + durationMs);
        const pad = (n: number) => String(n).padStart(2, "0");
        endIso =
          `${newEnd.getFullYear()}-${pad(newEnd.getMonth() + 1)}-${pad(newEnd.getDate())}` +
          `T${pad(newEnd.getHours())}:${pad(newEnd.getMinutes())}:00`;
      }
    }
    void scheduleOnce(page.id, iso, endIso);
  }

  function handleEndChange(endIso: string | null) {
    if (page.scheduledStart) {
      void scheduleOnce(page.id, page.scheduledStart, endIso ?? undefined);
    }
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
