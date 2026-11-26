// For continuous-input fields only. Immediate-save fields (status, priority,
// tags) should NOT use this — call updatePage directly.

import { useEffect, useRef, useState } from "react";

export interface AutosaveState {
  isSaving: boolean;
  saveError: Error | null;
  /** Marks unsaved input and restarts the debounce, for `delay` ms when given. Renders nothing, so it can run on every key. */
  schedule: (delay?: number) => void;
  flush: () => Promise<void>;
}

/**
 * Debounces `saveFn` after each `schedule()`. The caller holds the unsaved input and reads it when
 * `saveFn` runs, so marking a change costs no state update, re-render or copy per keystroke.
 * Flushes on unmount so page switches and app close never lose data; a failed save stays pending,
 * so the next flush or schedule retries it.
 */
export function useAutosave(
  saveFn: () => Promise<void>,
  options: { delay?: number } = {}
): AutosaveState {
  const delay = options.delay ?? 800;

  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<Error | null>(null);

  const isPendingRef = useRef(false);
  const saveFnRef = useRef(saveFn);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isSavingRef = useRef(false);
  const mountedRef = useRef(true);

  saveFnRef.current = saveFn;

  const doSave = useRef(async () => {
    if (!isPendingRef.current || isSavingRef.current) return;

    isPendingRef.current = false;
    isSavingRef.current = true;
    if (mountedRef.current) setIsSaving(true);

    try {
      await saveFnRef.current();
      if (mountedRef.current) setSaveError(null);
    } catch (err) {
      isPendingRef.current = true;
      if (mountedRef.current) setSaveError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      isSavingRef.current = false;
      if (mountedRef.current) setIsSaving(false);
    }
  });

  function clearTimer(): void {
    if (timerRef.current === null) return;

    clearTimeout(timerRef.current);
    timerRef.current = null;
  }

  const schedule = useRef((delayOverride?: number) => {
    isPendingRef.current = true;
    clearTimer();
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      void doSave.current();
    }, delayOverride ?? delay);
  });

  // Flush on unmount. mountedRef resets to true on each mount so StrictMode's remount doesn't
  // permanently disable setState.
  useEffect(() => {
    mountedRef.current = true;
    // Copied to a local for the cleanup closure; the linter can't prove the ref is stable.
    const save = doSave.current;
    return () => {
      mountedRef.current = false;
      clearTimer();
      void save();
    };
  }, []);

  const flush = useRef(async () => {
    clearTimer();
    await doSave.current();
  });

  return { flush: flush.current, isSaving, saveError, schedule: schedule.current };
}
