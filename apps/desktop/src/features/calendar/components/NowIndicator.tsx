import { mapDateToY } from "@pikos/core";

import { useCalendarSettings } from "@/shared/context/CalendarSettingsContext";

/**
 * The line paints under the page blocks that follow it, so it never strikes through a block's
 * title or time; only the dot rises above them, which keeps the current time findable when a
 * block covers the whole line.
 */
export function NowIndicator({ now }: { now: Date }) {
  const { geometry } = useCalendarSettings();
  const top = mapDateToY(now, geometry);

  return (
    <div
      aria-label="Current time"
      className="pointer-events-none absolute inset-x-0"
      role="separator"
      style={{ top }}
    >
      <div className="absolute -top-0.75 -left-1 z-20 h-2 w-2 rounded-full bg-primary" />
      <div className="h-px bg-primary" />
    </div>
  );
}
