import { type RefObject, useEffect } from "react";

/**
 * Focuses a field and drops the caret at the end when it swaps from its read-only div to its
 * textarea. Keyed on the focus flag alone: tied to the autosize effect, which depends on the value,
 * every keystroke re-ran it and dragged the caret to the end. The caret belongs to the swap.
 */
export function useCaretAtEndOnFocus(ref: RefObject<HTMLTextAreaElement | null>, focused: boolean) {
  useEffect(() => {
    const el = ref.current;
    if (!el || !focused) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, [ref, focused]);
}
