import type { Page } from "@playwright/test";
import { expect } from "./fixtures";

export interface LongTaskMetrics {
  /** ms — single longest long task observed (legacy "any long task" signal). */
  longest: number;
  /** ms — Total Blocking Time = sum(duration - 50) for tasks > 50ms. CWV-aligned. */
  tbt: number;
  /** count of long tasks (>50ms) — surfaces death-by-a-thousand-cuts that TBT alone can hide. */
  count: number;
}

/**
 * Start observing long tasks (>50ms) in the browser. Entries accumulate on `window[key]`
 * until {@link readLongTasks} drains them. Use `buffered: true` so any task that fired
 * before observation started (e.g., during page init for boot tests) is still captured.
 */
export async function observeLongTasks(page: Page, key: string) {
  await page.evaluate((k) => {
    interface ObsState {
      entries: PerformanceEntry[];
      obs?: PerformanceObserver;
    }
    const w = window as unknown as Record<string, ObsState>;
    w[k] = { entries: [] };
    const obs = new PerformanceObserver((list) => {
      w[k].entries.push(...list.getEntries());
    });
    // "longtask" is valid at runtime but not in the TS EntryType union
    obs.observe({ type: "longtask" as string, buffered: true });
    w[k].obs = obs;
  }, key);
}

/**
 * Read accumulated long-task metrics. `PerformanceObserver` delivers callbacks
 * asynchronously, so any task that fired in the ~100ms before this call may not
 * have been pushed into the callback yet. We yield two frames and then drain
 * pending records via `obs.takeRecords()` before computing.
 */
export async function readLongTasks(page: Page, key: string): Promise<LongTaskMetrics> {
  await page.evaluate(
    () =>
      new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())))
  );

  return page.evaluate((k) => {
    interface ObsState {
      entries: PerformanceEntry[];
      obs?: PerformanceObserver;
    }
    const w = window as unknown as Record<string, ObsState | undefined>;
    const state = w[k];
    if (!state) return { longest: 0, tbt: 0, count: 0 };
    const drained = state.obs?.takeRecords() ?? [];
    state.entries.push(...drained);
    let longest = 0;
    let tbt = 0;
    for (const e of state.entries) {
      if (e.duration > longest) longest = e.duration;
      if (e.duration > 50) tbt += e.duration - 50;
    }
    return { longest, tbt, count: state.entries.length };
  }, key);
}

/**
 * Emit a single-line JSON record so CI can scrape baselines. Always logs,
 * regardless of pass/fail or warnOnly — the point is trend visibility.
 */
function logPerf(record: Record<string, unknown>) {
  // eslint-disable-next-line no-console
  console.log(`[perf] ${JSON.stringify({ ...record, ts: Date.now() })}`);
}

interface AssertOpts {
  warnOnly?: boolean;
}

/**
 * Assert a single-value perf metric. Always logs `{metric, value, threshold, passed}`
 * so CI can scrape trend data even on passing runs.
 */
export function assertPerf(metric: string, actual: number, limit: number, opts: AssertOpts = {}) {
  const passed = actual < limit;
  logPerf({ metric, passed, threshold: limit, unit: "ms", value: actual });
  if (!opts.warnOnly) {
    expect(actual).toBeLessThan(limit);
  }
}

/**
 * Assert no blocking from long tasks. Uses TBT as the primary signal (matches
 * Lighthouse / Core Web Vitals) but also logs longest + count for diagnostics.
 *
 * Default `tbtLimit = 0` preserves the existing "any long task = regression" strictness.
 * Raise it on a per-test basis if a small amount of blocking is acceptable.
 */
export function assertNoBlocking(
  metric: string,
  m: LongTaskMetrics,
  opts: AssertOpts & { tbtLimit?: number } = {}
) {
  const tbtLimit = opts.tbtLimit ?? 0;
  const passed = m.tbt <= tbtLimit;
  logPerf({
    count: m.count,
    longest: m.longest,
    metric,
    passed,
    tbt: m.tbt,
    threshold: tbtLimit,
    unit: "ms",
  });
  if (!opts.warnOnly) {
    expect(m.tbt).toBeLessThanOrEqual(tbtLimit);
  }
}
