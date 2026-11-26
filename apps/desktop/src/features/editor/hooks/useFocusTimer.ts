// The `focus_sessions` producer, with two limits so the number stays something the user can account for.
//
//   * Nothing is persisted while a session runs. The row is written once, from real wall-clock
//     timestamps, when it ends: on stop, on leaving the page, or on quit or relaunch to update. A
//     session whose end the app never sees (a crash or force quit) is lost rather than closed out on
//     the next launch, because its end would be a guess, and a guess is worse than a missing session.
//   * Sessions under `MIN_SESSION_S` are discarded: opening a page and tapping play is not focus time,
//     and one-second rows would inflate the session count.
//
// Switching pages banks a running session: the editor remounts this hook per page (`key={page.id}`),
// so it is banked on unmount. A quit never unmounts, so it is banked from the pending-write flush too.

import type { NewFocusSession, StorageAdapter } from "@pikos/core";
import { formatElapsed, formatLocalISO, formatSessionLength, MIN_SESSION_S } from "@pikos/core";
import { useEffect, useRef, useState } from "react";

import { postNotice } from "@/shared/events/noticeBus";
import { createLogger } from "@/shared/logger";
import { onFlushPending } from "@/shared/pendingWrites";

const log = createLogger("useFocusTimer");

// Re-exported from `@pikos/core` so the components import them from the hook they belong with.
export { formatElapsed, MIN_SESSION_S };

interface PendingSession {
  storage: StorageAdapter | null;
  pageId: string;
  startedAt: Date;
}

export interface FocusTimerState {
  elapsedS: number;
  running: boolean;
  start: () => void;
  stop: () => Promise<void>;
}

export function useFocusTimer(storage: StorageAdapter | null, pageId: string): FocusTimerState {
  const [startedAt, setStartedAt] = useState<Date | null>(null);
  const [elapsedS, setElapsedS] = useState(0);

  // The quit and unmount flushes are registered once, so their closures can't see the current session;
  // this ref carries it, updated from an effect and cleared by whichever ends the session first so
  // none of them banks it twice.
  const pendingRef = useRef<PendingSession | null>(null);

  useEffect(() => {
    pendingRef.current = startedAt ? { pageId, startedAt, storage } : null;
  }, [pageId, startedAt, storage]);

  useEffect(() => {
    if (!startedAt) return;

    // Recomputed from the start time on each tick rather than incremented, so a
    // throttled background tab still shows real elapsed time. Each tick is aimed
    // at the next whole second since the start: a fixed interval drifts against
    // it, and two ticks inside one second hold the number, then skip one.
    const startMs = startedAt.getTime();
    let id: ReturnType<typeof setTimeout>;
    function tick() {
      const elapsedMs = Date.now() - startMs;
      setElapsedS(Math.floor(elapsedMs / 1000));
      id = setTimeout(tick, 1000 - (elapsedMs % 1000));
    }

    id = setTimeout(tick, 1000);
    return () => clearTimeout(id);
  }, [startedAt]);

  useEffect(() => {
    function bank() {
      const pending = pendingRef.current;
      pendingRef.current = null;
      if (!pending) return;

      return writeSession(pending.storage, pending.pageId, pending.startedAt);
    }

    const unregister = onFlushPending(bank);
    return () => {
      unregister();
      void bank();
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

/** Write one finished session, or decline to. Never throws: a lost session is a missing row on a
 *  settings card, not worth an error state in the editor. Both outcomes toast: ending is otherwise
 *  near-invisible, and a silent discard below the floor reads like a silent success. */
async function writeSession(
  storage: StorageAdapter | null,
  pageId: string,
  startedAt: Date | null
): Promise<void> {
  if (!storage || !startedAt) return;
  const ended = new Date();
  const durationS = Math.round((ended.getTime() - startedAt.getTime()) / 1000);
  if (durationS < MIN_SESSION_S) {
    postNotice(`Under ${MIN_SESSION_S} seconds, not recorded`);
    return;
  }
  const session: NewFocusSession = {
    durationS,
    endedAt: formatLocalISO(ended),
    pageId,
    startedAt: formatLocalISO(startedAt),
  };
  try {
    await storage.createFocusSession(session);
    postNotice(`Focused for ${formatSessionLength(durationS)}`);
  } catch (err) {
    log.warn("focus session not recorded", err);
    postNotice("Focus session finished, but it wasn't recorded.");
  }
}
