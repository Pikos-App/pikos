import { useEffect, useState } from "react";

function msUntilNextMinute(from: Date): number {
  return (60 - from.getSeconds()) * 1000 - from.getMilliseconds();
}

function sameMinute(a: Date, b: Date): boolean {
  return Math.floor(a.getTime() / 60_000) === Math.floor(b.getTime() / 60_000);
}

/**
 * The current time, refreshed at the top of each minute. Read time-dependent values
 * from it rather than from `new Date()` in render: the React Compiler caches a value
 * computed from no reactive input, so a re-render alone leaves it at the first render's
 * time. That froze the calendar's current-time line.
 *
 * Coming back to the window ticks at once and re-aligns to the minute. WebKit holds back
 * a hidden window's timers, so the line used to sit where it was left until a late tick
 * caught up.
 *
 * Starting reads the clock too. A hidden `<Activity>` keeps this state but drops the timer
 * and listeners, so the calendar shown again after the editor kept the time it was hidden at.
 * A read in the same minute keeps the old value, so a fresh mount, every list row among
 * them, doesn't render twice.
 */
export function useNow(): Date {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    const tick = () => {
      const at = new Date();
      setNow((prev) => (sameMinute(prev, at) ? prev : at));
      clearTimeout(timeoutId);
      timeoutId = setTimeout(tick, msUntilNextMinute(at));
    };
    const resume = () => {
      if (document.visibilityState === "visible") tick();
    };

    tick();
    document.addEventListener("visibilitychange", resume);
    window.addEventListener("focus", resume);

    return () => {
      clearTimeout(timeoutId);
      document.removeEventListener("visibilitychange", resume);
      window.removeEventListener("focus", resume);
    };
  }, []);

  return now;
}
