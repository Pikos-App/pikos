// Vertical panel resize — same pattern as usePanelResize but for height (Y-axis).
// The drag handle sits at the bottom edge of the panel; dragging it changes the height.

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
  onResizeStart: (e: React.MouseEvent) => void;
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

  function onResizeStart(e: React.MouseEvent) {
    e.preventDefault();
    const startY = e.clientY;
    const startHeight = heightRef.current;

    const onMove = (ev: MouseEvent) => {
      const h = Math.max(min, Math.min(max, startHeight + ev.clientY - startY));
      setHeight(h);
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }

  return { height, onResizeStart };
}
