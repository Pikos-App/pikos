import { DRAG_THRESHOLD } from "@pikos/core";

/**
 * Pointerdown-to-pointermove drag-threshold detector. Fires `onCrossed` the first time the
 * pointer moves more than `DRAG_THRESHOLD` px from where it started, then disconnects; drag
 * state is the caller's. A release before the threshold (a click) just tears down.
 *
 * Pointer events so a finger or pen works. Non-primary pointers are ignored: a second finger
 * must not steer the first one's gesture. `pointercancel` (system swipe, palm rejection) tears
 * down like an early release.
 *
 * `bodyCursor`, when set, is added to <html> on pointerdown and removed on a click-release;
 * once the threshold is crossed the caller owns it.
 */
export function beginDragThreshold(
  startX: number,
  startY: number,
  opts: {
    onCrossed: () => void;
    bodyCursor?: "dragging-grab" | "dragging-resize";
  }
): void {
  if (opts.bodyCursor) {
    document.documentElement.classList.add(opts.bodyCursor);
  }
  let crossed = false;

  function onMove(ev: PointerEvent) {
    if (!ev.isPrimary) return;
    if (
      Math.abs(ev.clientX - startX) > DRAG_THRESHOLD ||
      Math.abs(ev.clientY - startY) > DRAG_THRESHOLD
    ) {
      crossed = true;
      teardown();
      opts.onCrossed();
    }
  }

  function onUp(ev: PointerEvent) {
    if (!ev.isPrimary) return;
    teardown();
    if (!crossed && opts.bodyCursor) {
      document.documentElement.classList.remove(opts.bodyCursor);
    }
  }

  function teardown() {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("pointercancel", onUp);
  }

  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
  window.addEventListener("pointercancel", onUp);
}
