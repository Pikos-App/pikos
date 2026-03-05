// React hooks for the Keyboard registry.
// Registry logic lives in registry.ts — this file adds React lifecycle integration.
//
// Usage:
//   Single:   useKeyboardShortcut('Mod+Shift+D', handler, { scope: 'global' })
//   Chord:    useKeyboardShortcut(['Mod+K', 'Mod+O'], handler)
//   Scope:    useKeyboardScope('modal')   — push on mount, pop on unmount
//   Listener: useKeyboardListener()       — mount once in App.tsx

import { useEffect, useLayoutEffect, useRef } from "react";
import { Keyboard, type Binding } from "./registry";

type ShortcutOpts = Omit<Binding, "id" | "combo" | "handler">;

const CHORD_TIMEOUT_MS = 400;

/**
 * Registers a keyboard shortcut for the lifetime of the component.
 * Automatically unregisters on unmount.
 *
 * Single: useKeyboardShortcut('Mod+Shift+D', handler)
 * Chord:  useKeyboardShortcut(['Mod+K', 'Mod+O'], handler)
 *
 * `handler` and `opts.when` are kept in refs — safe to pass inline functions
 * without causing re-registrations on every render.
 */
export function useKeyboardShortcut(
  combo: string | [string, string],
  handler: () => void,
  opts?: ShortcutOpts
): void {
  // Stable refs for callbacks — kept current via useLayoutEffect (not during render)
  const handlerRef = useRef(handler);
  const whenRef = useRef(opts?.when);
  useLayoutEffect(() => {
    handlerRef.current = handler;
    whenRef.current = opts?.when;
  });

  // Scalar opts — extract individually so they can be deps
  const first = Array.isArray(combo) ? combo[0] : combo;
  const second = Array.isArray(combo) ? combo[1] : undefined;
  const scope = opts?.scope;
  const preventDefault = opts?.preventDefault;
  const allowInInputs = opts?.allowInInputs;
  const repeat = opts?.repeat;
  const stopPropagation = opts?.stopPropagation;

  useEffect(() => {
    const id = `shortcut-${crypto.randomUUID()}`;
    // Wrappers read from refs so the latest handler/when is always used
    const stableHandler = () => handlerRef.current();
    const stableWhen = () => whenRef.current?.() ?? true;

    const baseOpts = {
      scope: scope ?? "global",
      when: stableWhen,
      ...(preventDefault !== undefined && { preventDefault }),
      ...(allowInInputs !== undefined && { allowInInputs }),
      ...(repeat !== undefined && { repeat }),
      ...(stopPropagation !== undefined && { stopPropagation }),
    };

    if (second !== undefined) {
      // ── Chord binding ────────────────────────────────────────────────────
      // First key arms the chord by pushing a transient scope.
      // Second key (within CHORD_TIMEOUT_MS) fires the handler.
      // Timeout or any non-matching key clears the chord scope.
      const chordScope = `chord:${id}`;
      const secondId = `${id}-second`;
      let timer: ReturnType<typeof setTimeout> | null = null;

      function clearChord() {
        if (timer !== null) {
          clearTimeout(timer);
          timer = null;
        }
        Keyboard.popScope(chordScope);
        Keyboard.unregister(secondId);
      }

      Keyboard.register({
        id: secondId,
        combo: second,
        scope: chordScope,
        when: stableWhen,
        handler: () => {
          clearChord();
          stableHandler();
        },
      });

      Keyboard.register({
        id,
        combo: first,
        ...baseOpts,
        handler: () => {
          Keyboard.pushScope(chordScope);
          timer = setTimeout(clearChord, CHORD_TIMEOUT_MS);
        },
      });

      return () => {
        clearChord();
        Keyboard.unregister(id);
        Keyboard.unregister(secondId);
      };
    }

    // ── Single binding ─────────────────────────────────────────────────────
    Keyboard.register({ id, combo: first, handler: stableHandler, ...baseOpts });
    return () => Keyboard.unregister(id);
  }, [first, second, scope, preventDefault, allowInInputs, repeat, stopPropagation]);
}

/**
 * Pushes a keyboard scope on mount, pops it on unmount.
 * Use in modals and dialogs to isolate shortcuts to that context.
 */
export function useKeyboardScope(scope: string): void {
  useEffect(() => {
    Keyboard.pushScope(scope);
    return () => Keyboard.popScope(scope);
  }, [scope]);
}

/**
 * Attaches the global keydown listener. Call once in App.tsx.
 * All shortcuts registered via useKeyboardShortcut flow through here.
 */
export function useKeyboardListener(): void {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => Keyboard.handle(e);
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);
}
