import { useEffect, useLayoutEffect, useRef } from "react";

import { type Binding, Keyboard } from "./registry";

type ShortcutOpts = Omit<Binding, "id" | "combo" | "handler">;

const CHORD_TIMEOUT_MS = 400;

/**
 * Registers a keyboard shortcut for the component's lifetime: a combo, or a chord given as an
 * array (`['Mod+K', 'Mod+O']`). `handler` and `opts.when` are kept in refs, so inline functions
 * don't re-register on every render.
 */
export function useKeyboardShortcut(
  combo: string | [string, string],
  handler: (e: KeyboardEvent) => void,
  opts?: ShortcutOpts
): void {
  const handlerRef = useRef(handler);
  const whenRef = useRef(opts?.when);
  useLayoutEffect(() => {
    handlerRef.current = handler;
    whenRef.current = opts?.when;
  });

  const first = Array.isArray(combo) ? combo[0] : combo;
  const second = Array.isArray(combo) ? combo[1] : undefined;
  const scope = opts?.scope;
  const preventDefault = opts?.preventDefault;
  const allowInInputs = opts?.allowInInputs;
  const unlessHandled = opts?.unlessHandled;
  const repeat = opts?.repeat;
  const stopPropagation = opts?.stopPropagation;
  const label = opts?.label;
  const group = opts?.group;
  // Stryker disable next-line OptionalChaining: the label and group reads above already need the options
  const inPalette = opts?.inPalette;
  const destructive = opts?.destructive;

  useEffect(() => {
    const id = `shortcut-${crypto.randomUUID()}`;
    const stableHandler = (e: KeyboardEvent) => handlerRef.current(e);
    const stableWhen = () => whenRef.current?.() ?? true;

    const baseOpts = {
      scope: scope ?? "global",
      when: stableWhen,
      ...(preventDefault !== undefined && { preventDefault }),
      ...(allowInInputs !== undefined && { allowInInputs }),
      ...(unlessHandled !== undefined && { unlessHandled }),
      ...(repeat !== undefined && { repeat }),
      ...(stopPropagation !== undefined && { stopPropagation }),
      // Only the first key of a chord carries palette and settings metadata; the second half isn't a command.
      ...(label !== undefined && { label }),
      ...(group !== undefined && { group }),
      // Stryker disable next-line ConditionalExpression: spreading an undefined inPalette equals leaving it out
      ...(inPalette !== undefined && { inPalette }),
      ...(destructive !== undefined && { destructive }),
    };

    if (second !== undefined) {
      // The first key arms the chord with a transient scope; the second (within CHORD_TIMEOUT_MS)
      // fires. A timeout or non-matching key clears it.
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
        combo: second,
        handler: (e) => {
          clearChord();
          stableHandler(e);
        },
        id: secondId,
        scope: chordScope,
        when: stableWhen,
      });

      Keyboard.register({
        combo: first,
        id,
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

    Keyboard.register({ combo: first, handler: stableHandler, id, ...baseOpts });
    return () => Keyboard.unregister(id);
  }, [
    first,
    second,
    scope,
    preventDefault,
    allowInInputs,
    unlessHandled,
    repeat,
    stopPropagation,
    label,
    group,
    inPalette,
    destructive,
  ]);
}

export function useKeyboardScope(scope: string): void {
  useEffect(() => {
    Keyboard.pushScope(scope);
    return () => Keyboard.popScope(scope);
  }, [scope]);
}

export function useKeyboardListener(): void {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => Keyboard.handle(e);
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);
}
