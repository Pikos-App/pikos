import { mapDateToY } from "@pikos/core";

import { useCalendarSettings } from "@/shared/context/CalendarSettingsContext";

export function NowIndicator({ now }: { now: Date }) {
  const { geometry } = useCalendarSettings();
  const top = mapDateToY(now, geometry);

  return (
    <div
      aria-label="Current time"
      className="pointer-events-none absolute inset-x-0 z-20"
      role="separator"
      style={{ top }}
    >
      <div className="absolute -top-0.75 -left-1 h-2 w-2 rounded-full bg-primary" />
      <div className="h-px bg-primary" />
    </div>
  );
}
