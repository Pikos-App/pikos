import { invoke } from "@tauri-apps/api/core";

/** What the bench build's Rust side reports: the scratch workspace to open, and how long the
 *  process has been running. */
export interface BenchSession {
  db: string;
  uptimeMs: number;
}

export interface BenchPlan {
  folders: { id: string; name: string }[];
  openPages: number;
  pages: string[];
}

interface Footprint {
  bytes: number;
  peakBytes: number;
}

export interface BenchMemory {
  app: Footprint | null;
  window: Footprint | null;
  windowCandidates: number;
}

/** The steps of a launch, each as milliseconds since the process started. */
export type LaunchStage =
  | "connected"
  | "documentReady"
  | "firstRow"
  | "loaded"
  | "shellReady"
  | "webviewStart"
  | "workspaceRequested";

/** Adds to `performance.now()` to give milliseconds since the process started. */
let uptimeOffset = 0;
const stages: Partial<Record<LaunchStage, number>> = {};
let firstRow: Promise<void> = Promise.resolve();

/**
 * Called by the workspace as it starts opening. Lines the window's clock up with the process's,
 * and starts watching for the restored list's first row from before anything could draw one.
 */
export async function startLaunch(): Promise<BenchSession> {
  const before = performance.now();
  const session = await invoke<BenchSession>("bench_session");
  uptimeOffset = session.uptimeMs - (before + performance.now()) / 2;
  stages.workspaceRequested = before + uptimeOffset;
  firstRow = whenShown(() => document.querySelector(FIRST_ROW) != null, "the first row", 120_000)
    .then(nextPaint)
    .then(() => {
      stages.firstRow = performance.now() + uptimeOffset;
    });
  return session;
}

const FIRST_ROW = '[role="group"] [data-page-list-item]';

export function markStage(stage: LaunchStage) {
  stages[stage] = performance.now() + uptimeOffset;
}

/** The launch's steps once its first row is drawn. */
export async function launchStages(): Promise<Partial<Record<LaunchStage, number>>> {
  await firstRow;
  const navigation = performance.getEntriesByType("navigation")[0] as
    | PerformanceNavigationTiming
    | undefined;
  const ready = performance.getEntriesByName("pikos:ready")[0];
  return {
    ...stages,
    documentReady: (navigation?.domContentLoadedEventEnd ?? 0) + uptimeOffset,
    ...(ready && { shellReady: ready.startTime + uptimeOffset }),
    webviewStart: uptimeOffset,
  };
}

export function benchPlan(pages: number): Promise<BenchPlan> {
  return invoke<BenchPlan>("bench_plan", { pages });
}

export function benchMemory(): Promise<BenchMemory> {
  return invoke<BenchMemory>("bench_memory");
}

/** Hand the results to Rust, which writes them where the benchmark script asked and quits. */
export function benchFinish(results: unknown): Promise<void> {
  return invoke<void>("bench_finish", { results });
}

/** Resolve the moment `check` holds, re-checking on every change to the page rather than once a
 *  frame, so the waiting adds no frames of its own to what it times. */
export function whenShown(check: () => boolean, what: string, timeoutMs = 30_000): Promise<void> {
  if (check()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const observer = new MutationObserver(() => {
      if (!check()) return;
      stop();
      resolve();
    });
    const timer = window.setTimeout(() => {
      stop();
      reject(new Error(`timed out waiting for ${what}`));
    }, timeoutMs);
    function stop() {
      observer.disconnect();
      window.clearTimeout(timer);
    }
    observer.observe(document.documentElement, {
      attributes: true,
      characterData: true,
      childList: true,
      subtree: true,
    });
  });
}

/** The next paint: frame callbacks run just before it, and a task queued from one runs just after. */
export function nextPaint(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => window.setTimeout(resolve, 0)));
}
