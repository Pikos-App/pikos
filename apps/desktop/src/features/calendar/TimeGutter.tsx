import { GRID_END_HOUR, GRID_START_HOUR, HOUR_HEIGHT } from "./calendarUtils";

export function TimeGutter() {
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

        return (
          <div
            className="relative flex items-start justify-end pr-2"
            key={hour}
            style={{ height: HOUR_HEIGHT }}
          >
            <span className="-mt-2 text-[10px] text-muted-foreground/60">{label}</span>
          </div>
        );
      })}
    </div>
  );
}
