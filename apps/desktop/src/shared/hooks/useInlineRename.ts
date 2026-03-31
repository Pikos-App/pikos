import { useEffect, useRef } from "react";

/**
 * Shared rename state for sidebar list items (folders, pages).
 * Manages the input ref, focus-on-activate, and Radix focus-restore suppression
 * when rename is triggered from a context menu.
 */
export function useInlineRename(isRenaming: boolean) {
  const inputRef = useRef<HTMLInputElement>(null);
  const suppressRef = useRef(false);

  useEffect(() => {
    if (!isRenaming) return;
    // Retry focus across a few frames — the input may not be mounted yet
    // when a new folder is created and renaming starts in the same batch.
    let attempt = 0;
    function tryFocus() {
      const el = inputRef.current;
      if (el) {
        el.focus();
        el.setSelectionRange(el.value.length, el.value.length);
      } else if (attempt < 5) {
        attempt++;
        requestAnimationFrame(tryFocus);
      }
    }
    requestAnimationFrame(tryFocus);
  }, [isRenaming]);

  /**
   * Call instead of `onRenameStart` when triggered from a ContextMenuItem.
   * Sets the suppress flag so Radix doesn't steal focus back from the input
   * when the menu closes.
   */
  function prepareRenameFromMenu(onRenameStart: () => void) {
    suppressRef.current = true;
    onRenameStart();
  }

  /** Spread onto <ContextMenuContent> to suppress focus restore after menu-triggered rename. */
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
