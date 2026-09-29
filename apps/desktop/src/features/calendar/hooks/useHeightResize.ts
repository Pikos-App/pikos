import { useLayoutEffect, useRef } from "react";

import { useLocalStorage } from "@/shared/hooks/useLocalStorage";

interface HeightResizeOptions {
  storageKey: string;
  defaultHeight: number;
  min: number;
  max: number;
}

interface HeightResize {
  height: number;
  onResizeStart: (e: React.PointerEvent<HTMLElement>) => void;
}

export function useHeightResize({
  defaultHeight,
  max,
  min,
  storageKey,
}: HeightResizeOptions): HeightResize {
  const [height, setHeight] = useLocalStorage(storageKey, defaultHeight);

  const heightRef = useRef(height);
  useLayoutEffect(() => {
    heightRef.current = height;
  }, [height]);

  /**
   * Pointer capture rather than document-level listeners: it routes every
   * later event for this pointer back to the handle, so the drag keeps
   * tracking once the cursor leaves the 3px bar without the hook having to
   * own — and later remember to remove — a pair of global listeners. It also
   * scopes the gesture to one pointer, so a second finger can't fight it.
   */
  function onResizeStart(e: React.PointerEvent<HTMLElement>) {
    if (!e.isPrimary) return;
    e.preventDefault();
    const handle = e.currentTarget;
    const { pointerId } = e;
    const startY = e.clientY;
    const startHeight = heightRef.current;
    handle.setPointerCapture(pointerId);

    const onMove = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      const h = Math.max(min, Math.min(max, startHeight + ev.clientY - startY));
      setHeight(h);
    };
    // pointerup and pointercancel both end the gesture; the height already
    // committed on every move, so there is nothing to roll back either way.
    const onEnd = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onEnd);
      handle.removeEventListener("pointercancel", onEnd);
      if (handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId);
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onEnd);
    handle.addEventListener("pointercancel", onEnd);
  }

  return { height, onResizeStart };
}
