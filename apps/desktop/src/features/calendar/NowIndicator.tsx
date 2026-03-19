import { useEffect, useState } from "react";

import { timeToY } from "./calendarUtils";

export function NowIndicator() {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const interval = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(interval);
  }, []);

  const top = timeToY(now);

  return (
    <div className="pointer-events-none absolute inset-x-0 z-20" style={{ top }}>
      {/* Dot on the left edge */}
      <div className="absolute -top-1 -left-1 h-2 w-2 rounded-full bg-primary" />
      {/* Line spanning full width */}
      <div className="h-px bg-primary" />
    </div>
  );
}
