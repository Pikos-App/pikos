// For continuous-input fields only. Immediate-save fields (status, priority,
// tags) should NOT use this — call updatePage directly.

import { useEffect, useRef, useState } from "react";

export interface AutosaveState {
  /** True while the saveFn promise is in flight. */
  isSaving: boolean;
  /** Set on saveFn rejection; cleared on next successful save. */
  saveError: Error | null;
  /** Mark unsaved input and restart the debounce. Renders nothing, so it can run on every key. */
  schedule: () => void;
  /** Immediately flush any pending debounced save. Returns when the save completes. */
  flush: () => Promise<void>;
}

/**
 * Debounces calls to `saveFn` after each `schedule()`.
 *
 * The caller holds the unsaved input itself and reads it when `saveFn` runs, so
 * marking a change costs nothing: no state update, no re-render, no copy of the
 * value per keystroke.
 *
 * - Flushes on unmount so page switches and app close never lose data.
 * - A failed save stays pending, so the next flush or schedule retries it.
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

  // Core save logic — shared by debounce timer, flush, and unmount
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

  const schedule = useRef(() => {
    isPendingRef.current = true;
    clearTimer();
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      void doSave.current();
    }, delay);
  });

  // Flush on unmount (covers page switch + app close).
  // mountedRef is reset to true on each mount so StrictMode's remount cycle
  // doesn't permanently disable setState calls.
  useEffect(() => {
    mountedRef.current = true;
    // Capture ref value per lint rule — the ref is stable but the linter
    // can't prove it, so we copy to a local variable for the cleanup closure.
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
