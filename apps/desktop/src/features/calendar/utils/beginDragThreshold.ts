import { DRAG_THRESHOLD } from "@pikos/core";

/**
 * Wires up a mousedown→mousemove drag-threshold detector. Fires `onCrossed`
 * the first time the cursor moves more than `DRAG_THRESHOLD` px from its
 * starting coordinates and then disconnects — downstream drag state is the
 * caller's responsibility. A release before the threshold (a "click", not a
 * drag) just tears the listeners down.
 *
 * `bodyCursor` is optional: when set, the class is added to <html> on
 * mousedown for instant feedback and removed on a click-release. After the
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

  function onMove(ev: MouseEvent) {
    if (
      Math.abs(ev.clientX - startX) > DRAG_THRESHOLD ||
      Math.abs(ev.clientY - startY) > DRAG_THRESHOLD
    ) {
      crossed = true;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      opts.onCrossed();
    }
  }

  function onUp() {
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", onUp);
    if (!crossed && opts.bodyCursor) {
      document.documentElement.classList.remove(opts.bodyCursor);
    }
  }

  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", onUp);
}
