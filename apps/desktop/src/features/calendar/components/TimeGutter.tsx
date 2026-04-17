import { cn } from "@/lib/utils";
import { useCalendarSettings } from "@/shared/context/CalendarSettingsContext";

import { GRID_END_HOUR, GRID_START_HOUR } from "../utils/calendarUtils";

export function TimeGutter() {
  const { metrics } = useCalendarSettings();
  const hours = Array.from(
    { length: GRID_END_HOUR - GRID_START_HOUR },
    (_, i) => GRID_START_HOUR + i
  );

  return (
    <div aria-hidden="true" className="w-14 shrink-0 select-none">
      {hours.map((hour) => {
        const label =
          hour === 0
            ? "12 AM"
            : hour < 12
              ? `${hour} AM`
              : hour === 12
                ? "12 PM"
                : `${hour - 12} PM`;

        // Every other label sits above its hour line (-mt-2). The 12 AM label
        // has no line above it (it's the top of the grid), so pin it below the
        // edge to keep it fully visible.
        const isFirst = hour === GRID_START_HOUR;
        return (
          <div
            className="relative flex items-start justify-end pr-2"
            key={hour}
            style={{ height: metrics.hourHeight }}
          >
            <span className={cn("type-ui-sm text-subtle", isFirst ? "mt-1" : "-mt-2")}>
              {label}
            </span>
          </div>
        );
      })}
    </div>
  );
}
