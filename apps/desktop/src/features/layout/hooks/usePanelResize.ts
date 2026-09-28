import { useLayoutEffect, useRef } from "react";

import { useInterfaceSettings } from "@/shared/context/InterfaceSettingsContext";
import { useLocalStorage } from "@/shared/hooks/useLocalStorage";

interface PanelResizeOptions {
  storageKey: string;
  defaultWidth: number;
  min: number;
  max: number;
  /** The widest this panel may draw on screen, once the calendar and the other
   *  panel have taken theirs. A panel yields to its own `min` before it yields
   *  to this: a ceiling narrower than the text needs crushes the panel, and the
   *  breakpoints already hide one a window genuinely cannot hold. */
  ceiling: number;
}

interface PanelResize {
  width: number;
  onResizeStart: (e: React.MouseEvent) => void;
}

/**
 * A panel's width in px, scaled so the panel holds the same amount of text at
 * any interface text size.
 *
 * The stored number is the width at 100%, never the width on screen, and `min`
 * and `max` bound that same base. Storing what is on screen instead makes the
 * setting irreversible: a divider dragged at 200% persists a 200%-sized number,
 * and going back to 100% leaves the panel stuck wide.
 */
export function usePanelResize({
  ceiling,
  defaultWidth,
  max,
  min,
  storageKey,
}: PanelResizeOptions): PanelResize {
  const [storedBaseWidth, setStoredBaseWidth] = useLocalStorage(storageKey, defaultWidth);
  const { textScale } = useInterfaceSettings();

  const maxBase = Math.max(min, Math.min(max, Math.floor(ceiling / textScale)));
  const baseWidth = Math.max(min, Math.min(maxBase, storedBaseWidth));
  const width = Math.round(baseWidth * textScale);

  const widthRef = useRef(width);
  useLayoutEffect(() => {
    widthRef.current = width;
  }, [width]);

  function onResizeStart(e: React.MouseEvent) {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = widthRef.current;
    const handle = e.currentTarget as HTMLElement;
    handle.dataset["dragging"] = "true";

    const onMove = (ev: MouseEvent) => {
      // The cursor moves in screen px; the store holds base px.
      const base = (startWidth + ev.clientX - startX) / textScale;
      setStoredBaseWidth(Math.round(Math.max(min, Math.min(maxBase, base))));
    };
    const onUp = () => {
      delete handle.dataset["dragging"];
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }

  return { onResizeStart, width };
}
