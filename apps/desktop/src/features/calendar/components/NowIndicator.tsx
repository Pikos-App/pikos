import { useCalendarSettings } from "@/shared/context/CalendarSettingsContext";

import { timeToY } from "../utils/calendarUtils";

export function NowIndicator({ now }: { now: Date }) {
  const { metrics } = useCalendarSettings();
  const top = timeToY(now, metrics.hourHeight);

  return (
    <div className="pointer-events-none absolute inset-x-0 z-20" style={{ top }}>
      <div className="absolute -top-0.75 -left-1 h-2 w-2 rounded-full bg-primary" />
      <div className="h-px bg-primary" />
    </div>
  );
}
