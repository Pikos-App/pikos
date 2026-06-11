// For continuous-input fields only. Immediate-save fields (status, priority,
// tags) should NOT use this — call updatePage directly.

import { useEffect, useRef, useState } from "react";

export interface AutosaveState {
  /** True when the local value differs from the last successfully saved value. */
  isDirty: boolean;
  /** True while the saveFn promise is in flight. */
  isSaving: boolean;
  /** Set on saveFn rejection; cleared on next successful save. */
  saveError: Error | null;
  /** Immediately flush any pending debounced save. Returns when the save completes. */
  flush: () => Promise<void>;
}

/**
 * Debounces calls to `saveFn` whenever `value` changes.
 *
 * - Compares by reference (===). For objects, the caller should produce a new
 *   reference only when the value has actually changed.
 * - Flushes on unmount so page switches and app close never lose data.
 * - The `flush()` returned in state can be called imperatively for blur/close handlers.
 */
export function useAutosave<T>(
  value: T,
  saveFn: (val: T) => Promise<void>,
  options: { delay?: number } = {}
): AutosaveState {
  const delay = options.delay ?? 800;

  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<Error | null>(null);

  // Refs to avoid stale closures in the timer callback
  const latestValue = useRef(value);
  const savedValue = useRef(value);
  const saveFnRef = useRef(saveFn);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isSavingRef = useRef(false);
  const mountedRef = useRef(true);

  latestValue.current = value;
  saveFnRef.current = saveFn;

  const isDirty = value !== savedValue.current;

  // Core save logic — shared by debounce timer, flush, and unmount
  const doSave = useRef(async () => {
    const val = latestValue.current;
    if (val === savedValue.current) return;
    if (isSavingRef.current) return;

    isSavingRef.current = true;
    if (mountedRef.current) setIsSaving(true);

    try {
      await saveFnRef.current(val);
      savedValue.current = val;
      if (mountedRef.current) setSaveError(null);
    } catch (err) {
      if (mountedRef.current) setSaveError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      isSavingRef.current = false;
      if (mountedRef.current) setIsSaving(false);
    }
  });

  useEffect(() => {
    if (value === savedValue.current) return;

    if (timerRef.current !== null) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      void doSave.current();
    }, delay);

    return () => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [value, delay]);

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
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      void save();
    };
  }, []);

  const flush = useRef(async () => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    await doSave.current();
  });

  return { flush: flush.current, isDirty, isSaving, saveError };
}
