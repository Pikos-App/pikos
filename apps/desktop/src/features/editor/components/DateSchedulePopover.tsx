import type { Page } from "@pikos/core";
import { computeScheduleTransition, isDone, normalizeEndInput } from "@pikos/core";

import { DateTimePicker } from "@/shared/components/DateTimePicker";
import { usePages } from "@/shared/context/PagesContext";
interface DateSchedulePopoverProps {
  page: Page;
}

export function DateSchedulePopover({ page }: DateSchedulePopoverProps) {
  const { clearSchedule, scheduleOnce } = usePages();

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
      isDone={isDone(page)}
      onChange={handleDateChange}
      onEndChange={handleEndChange}
      value={page.scheduledStart ?? null}
    />
  );
}
