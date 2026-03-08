import { useEffect, useState } from "react";

/**
 * Returns a counter that increments once per minute, causing the caller to
 * re-render at the top of each new minute. Use this to recompute time-sensitive
 * derived values (e.g. overdue vs today grouping) without polling the DB.
 */
export function useMinuteTick(): number {
  const [tick, setTick] = useState(0);

  useEffect(() => {
    // Align the first tick to the next whole minute so subsequent ticks fire
    // at :00 rather than drifting from whenever the component mounted.
    const now = new Date();
    const msUntilNextMinute = (60 - now.getSeconds()) * 1000 - now.getMilliseconds();

    let intervalId: ReturnType<typeof setInterval> | undefined;

    const timeoutId = setTimeout(() => {
      setTick((t) => t + 1);
      intervalId = setInterval(() => setTick((t) => t + 1), 60_000);
    }, msUntilNextMinute);

    return () => {
      clearTimeout(timeoutId);
      if (intervalId !== undefined) clearInterval(intervalId);
    };
  }, []);

  return tick;
}
