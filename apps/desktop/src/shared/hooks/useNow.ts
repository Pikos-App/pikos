import { useEffect, useState } from "react";

/**
 * The current time, refreshed at the top of each minute. Read time-dependent values
 * from it rather than from `new Date()` in render: the React Compiler caches a value
 * computed from no reactive input, so a re-render alone leaves it at the first render's
 * time. That froze the calendar's current-time line.
 */
export function useNow(): Date {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    // Align to the next whole minute so the clock reads :00, not mount time plus 60s.
    const start = new Date();
    const msUntilNextMinute = (60 - start.getSeconds()) * 1000 - start.getMilliseconds();

    let intervalId: ReturnType<typeof setInterval> | undefined;

    const timeoutId = setTimeout(() => {
      setNow(new Date());
      intervalId = setInterval(() => setNow(new Date()), 60_000);
    }, msUntilNextMinute);

    return () => {
      clearTimeout(timeoutId);
      if (intervalId !== undefined) clearInterval(intervalId);
    };
  }, []);

  return now;
}
