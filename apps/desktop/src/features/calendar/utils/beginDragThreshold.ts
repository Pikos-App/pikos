import { DRAG_THRESHOLD } from "@pikos/core";

/**
 * Wires up a pointerdown→pointermove drag-threshold detector. Fires `onCrossed`
 * the first time the pointer moves more than `DRAG_THRESHOLD` px from its
 * starting coordinates and then disconnects — downstream drag state is the
 * caller's responsibility. A release before the threshold (a "click", not a
 * drag) just tears the listeners down.
 *
 * Pointer events rather than mouse events so the same gesture works from a
 * finger or a pen. Non-primary pointers are ignored: a second finger landing
 * mid-drag must not steer the gesture the first one started. `pointercancel`
 * (the platform taking the gesture away — a system swipe, a palm rejection)
 * tears down exactly like a release below the threshold.
 *
 * `bodyCursor` is optional: when set, the class is added to <html> on
 * pointerdown for instant feedback and removed on a click-release. After the
 * threshold is crossed, the caller (usually the drag handler on the parent
 * grid) owns class management — the helper leaves it set.
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
