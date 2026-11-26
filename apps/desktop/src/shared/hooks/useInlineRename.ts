import { useEffect, useRef } from "react";

/** Shared rename state for sidebar list items. */
export function useInlineRename(isRenaming: boolean) {
  const inputRef = useRef<HTMLInputElement | HTMLSpanElement>(null);
  const suppressRef = useRef(false);

  useEffect(() => {
    if (!isRenaming) return;
    // Retry across a few frames: the element may not be mounted yet when a new item is created and
    // renaming starts in the same batch.
    let attempt = 0;
    function tryFocus() {
      const el = inputRef.current;
      if (el) {
        el.focus();
        if (el instanceof HTMLInputElement) {
          el.setSelectionRange(el.value.length, el.value.length);
        } else {
          const range = document.createRange();
          range.selectNodeContents(el);
          range.collapse(false);
          const sel = window.getSelection();
          sel?.removeAllRanges();
          sel?.addRange(range);
        }
      } else if (attempt < 5) {
        attempt++;
        requestAnimationFrame(tryFocus);
      }
    }
    requestAnimationFrame(tryFocus);
  }, [isRenaming]);

  /**
   * Call instead of `onRenameStart` from a ContextMenuItem: sets the suppress flag so Radix doesn't
   * steal focus back from the input when the menu closes.
   */
  function prepareRenameFromMenu(onRenameStart: () => void) {
    suppressRef.current = true;
    onRenameStart();
  }

  const contextMenuContentProps = {
    onCloseAutoFocus(e: Event) {
      if (suppressRef.current) {
        e.preventDefault();
        suppressRef.current = false;
      }
    },
  } as const;

  return { contextMenuContentProps, inputRef, prepareRenameFromMenu };
}
