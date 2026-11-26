import { useSyncExternalStore } from "react";

/** The longest the clock goes without reading the time, so it never trusts one long timer. */
const CHECK_EVERY_MS = 5_000;

function sameMinute(a: Date, b: Date): boolean {
  return Math.floor(a.getTime() / 60_000) === Math.floor(b.getTime() / 60_000);
}

function msUntilNextMinute(from: Date): number {
  return (60 - from.getSeconds()) * 1000 - from.getMilliseconds();
}

/**
 * One clock for the whole app, current to the minute. Per-reader timers drift: one pauses in a
 * hidden calendar, one is held back while the window is out of view, one stalls through the
 * Mac's sleep. Here one timer reads the time at each minute's turn and at least every few
 * seconds, and a reader asks for the time when it draws, so a reader shown again, a window
 * brought back or a Mac woken up is current at once with nothing to catch up.
 */
const listeners = new Set<() => void>();
let now = new Date();
let timeoutId: ReturnType<typeof setTimeout> | undefined;

function tell(): void {
  for (const listener of listeners) listener();
}

function read(): boolean {
  const at = new Date();
  if (sameMinute(now, at)) return false;
  now = at;
  return true;
}

function tick(): void {
  clearTimeout(timeoutId);
  if (read()) tell();
  timeoutId = setTimeout(tick, Math.min(msUntilNextMinute(new Date()), CHECK_EVERY_MS));
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) {
    tick();
    // WebKit holds back a hidden window's timers, so its coming back reads at once.
    document.addEventListener("visibilitychange", tick);
    window.addEventListener("focus", tick);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size > 0) return;
    clearTimeout(timeoutId);
    document.removeEventListener("visibilitychange", tick);
    window.removeEventListener("focus", tick);
  };
}

function getSnapshot(): Date {
  if (read()) queueMicrotask(tell);
  return now;
}

/**
 * The current time, as of this minute. Read time-dependent values from it rather than from
 * `new Date()` in render: the React Compiler caches a value computed from no reactive
 * input, so a re-render alone leaves it at the first render's time.
 */
export function useNow(): Date {
  return useSyncExternalStore(subscribe, getSnapshot);
}
