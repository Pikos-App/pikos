import { useCalendarSettings } from "@/shared/context/CalendarSettingsContext";

import { mapDateToY } from "../utils/calendarGeometry";

export function NowIndicator({ now }: { now: Date }) {
  const { geometry } = useCalendarSettings();
  const top = mapDateToY(now, geometry);

  return (
    <div className="pointer-events-none absolute inset-x-0 z-20" style={{ top }}>
      <div className="absolute -top-0.75 -left-1 h-2 w-2 rounded-full bg-primary" />
      <div className="h-px bg-primary" />
    </div>
  );
}
