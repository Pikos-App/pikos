import { useLayoutEffect, useRef } from "react";

import { useInterfaceSettings } from "@/shared/context/InterfaceSettingsContext";
import { useLocalStorage } from "@/shared/hooks/useLocalStorage";
import { useWindowWidth } from "@/shared/hooks/useWindowWidth";

interface PanelResizeOptions {
  storageKey: string;
  defaultWidth: number;
  min: number;
  max: number;
  /** Share of the window this panel may not grow past, as a fraction. The two
   *  left panels' shares must sum to at most 0.5: the calendar is what a
   *  growing panel eats, and losing it is the failure PKOS-0067 rejected
   *  app-wide zoom to avoid. Only ever caps growth, never below `min`. */
  maxWindowShare: number;
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
  defaultWidth,
  max,
  maxWindowShare,
  min,
  storageKey,
}: PanelResizeOptions): PanelResize {
  const [storedBaseWidth, setStoredBaseWidth] = useLocalStorage(storageKey, defaultWidth);
  const { textScale } = useInterfaceSettings();
  const windowWidth = useWindowWidth();

  const baseWidth = Math.max(min, Math.min(max, storedBaseWidth));
  const cap = Math.max(min, Math.floor(windowWidth * maxWindowShare));
  const width = Math.min(Math.round(baseWidth * textScale), cap);

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
      setStoredBaseWidth(Math.round(Math.max(min, Math.min(max, base))));
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
