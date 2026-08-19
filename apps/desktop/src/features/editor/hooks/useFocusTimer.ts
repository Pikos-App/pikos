// The `focus_sessions` producer. The table has been in the schema since
// migration 001 and the Data panel has been summing it into a "Focus time" card
// all along, with nothing ever writing a row — so the card showed a hard zero
// that read as a measurement. This is the smallest honest writer for it.
//
// Two deliberate limits, both so the number stays something the user can
// account for:
//
//   * Nothing is persisted while a session runs. The elapsed count lives in
//     React state; quit the app mid-session and it is gone, because a session
//     the app cannot see the end of is a guess, and a guess in a total is worse
//     than a missing session. The row is written on stop, once, from real
//     wall-clock timestamps.
//   * Sessions under `MIN_SESSION_S` are discarded rather than written. Opening
//     a page, tapping play and moving on is not focus time; without a floor the
//     card fills with one-second rows that inflate the session count while
//     adding nothing to the minutes.
//
// Switching pages banks a running session rather than dropping it — the editor
// remounts this hook per page (`key={page.id}`), so the flush happens on unmount.

import type { NewFocusSession, StorageAdapter } from "@pikos/core";
import { formatLocalISO } from "@pikos/core";
import { useEffect, useRef, useState } from "react";

import { createLogger } from "@/shared/logger";

const log = createLogger("useFocusTimer");

/** Shortest session worth recording, in seconds. */
export const MIN_SESSION_S = 30;

/** What the unmount flush needs, captured while the session is running. */
interface PendingSession {
  storage: StorageAdapter | null;
  pageId: string;
  startedAt: Date;
}

export interface FocusTimerState {
  /** Seconds since the session started, ticking once a second. 0 when idle. */
  elapsedS: number;
  running: boolean;
  start: () => void;
  /** Ends the session and writes it, unless it was too short to count. */
  stop: () => Promise<void>;
}

export function useFocusTimer(storage: StorageAdapter | null, pageId: string): FocusTimerState {
  const [startedAt, setStartedAt] = useState<Date | null>(null);
  const [elapsedS, setElapsedS] = useState(0);

  // The unmount flush below runs from a cleanup registered once, so its closure
  // can't see the current session. This ref carries it across — kept up to date
  // from an effect rather than during render, and cleared by `stop` so a stop
  // immediately followed by an unmount can't bank the same session twice.
  const pendingRef = useRef<PendingSession | null>(null);

  useEffect(() => {
    pendingRef.current = startedAt ? { pageId, startedAt, storage } : null;
  }, [pageId, startedAt, storage]);

  useEffect(() => {
    if (!startedAt) return;
    // Recomputed from the start time on each tick rather than incremented, so a
    // throttled background tab (or a missed interval) still shows real elapsed
    // time instead of the number of ticks that happened to fire.
    const id = setInterval(() => {
      setElapsedS(Math.floor((Date.now() - startedAt.getTime()) / 1000));
    }, 1000);
    return () => clearInterval(id);
  }, [startedAt]);

  useEffect(() => {
    return () => {
      // Leaving the page (or closing the editor) ends the session where it is.
      const pending = pendingRef.current;
      pendingRef.current = null;
      if (pending) void writeSession(pending.storage, pending.pageId, pending.startedAt);
    };
  }, []);

  function start() {
    setStartedAt(new Date());
    setElapsedS(0);
  }

  async function stop() {
    const began = startedAt;
    pendingRef.current = null;
    setStartedAt(null);
    setElapsedS(0);
    await writeSession(storage, pageId, began);
  }

  return { elapsedS, running: startedAt !== null, start, stop };
}

/** Write one finished session, or decline to. Never throws: a lost session is a
 *  missing row on a settings card, not something worth an error state in the
 *  editor the user is typing in. */
async function writeSession(
  storage: StorageAdapter | null,
  pageId: string,
  startedAt: Date | null
): Promise<void> {
  if (!storage || !startedAt) return;
  const ended = new Date();
  const durationS = Math.round((ended.getTime() - startedAt.getTime()) / 1000);
  if (durationS < MIN_SESSION_S) return;
  const session: NewFocusSession = {
    durationS,
    endedAt: formatLocalISO(ended),
    pageId,
    startedAt: formatLocalISO(startedAt),
  };
  try {
    await storage.createFocusSession(session);
  } catch (err) {
    log.warn("focus session not recorded", err);
  }
}

/** `M:SS`, or `H:MM:SS` once an hour is up — read at a glance beside the byline,
 *  and monospaced by the caller so the digits don't shuffle as they tick. */
export function formatElapsed(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(s / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  const seconds = s % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}
