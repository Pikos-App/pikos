import { type RefObject, useEffect } from "react";

/**
 * Focuses a field and drops the caret at the end when it swaps from its
 * read-only div to its textarea.
 *
 * Keyed on the focus flag alone, deliberately. This used to live inside the
 * autosize effect, which also depends on the field's value, so every keystroke
 * re-ran it and dragged the caret to the end — typing into the middle of a
 * title was impossible. The caret belongs to the swap, not to the value.
 */
export function useCaretAtEndOnFocus(ref: RefObject<HTMLTextAreaElement | null>, focused: boolean) {
  useEffect(() => {
    const el = ref.current;
    if (!el || !focused) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, [ref, focused]);
}
