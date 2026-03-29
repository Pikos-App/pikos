import type { Page } from "@playwright/test";
import { expect } from "./fixtures";

/**
 * Start observing long tasks (>50ms) in the browser.
 * Returns a function to retrieve the longest observed task duration.
 */
export async function observeLongTasks(page: Page, key: string) {
  await page.evaluate((k) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any)[k] = 0;
    const obs = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        if (entry.duration > ((window as any)[k] ?? 0)) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (window as any)[k] = entry.duration;
        }
      }
    });
    // "longtask" is valid at runtime but not in the TS EntryType union
    obs.observe({ type: "longtask" as string, buffered: false });
  }, key);
}

export async function getLongestTask(page: Page, key: string): Promise<number> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return page.evaluate((k) => ((window as any)[k] as number) ?? 0, key);
}

/**
 * Assert a perf metric is within a limit.
 * When warnOnly is true, does not fail the test (for CI).
 */
export function assertPerf(actual: number, limit: number, warnOnly = false) {
  if (!warnOnly) {
    expect(actual).toBeLessThan(limit);
  }
}

/**
 * Assert no long tasks (>50ms) were observed.
 * When warnOnly is true, does not fail the test (for CI).
 */
export function assertNoLongTasks(longestTask: number, warnOnly = false) {
  if (!warnOnly) {
    expect(longestTask).toBe(0);
  }
}
