import { useCallback, useLayoutEffect, useRef } from "react";
import { useLocalStorage } from "@/shared/hooks/useLocalStorage";

interface PanelResizeOptions {
  storageKey: string;
  defaultWidth: number;
  min: number;
  max: number;
}

interface PanelResize {
  width: number;
  onResizeStart: (e: React.MouseEvent) => void;
}

export function usePanelResize({
  storageKey,
  defaultWidth,
  min,
  max,
}: PanelResizeOptions): PanelResize {
  const [width, setWidth] = useLocalStorage(storageKey, defaultWidth);

  const widthRef = useRef(width);
  useLayoutEffect(() => {
    widthRef.current = width;
  }, [width]);

  const onResizeStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const startX = e.clientX;
      const startWidth = widthRef.current;

      const onMove = (ev: MouseEvent) => {
        const w = Math.max(min, Math.min(max, startWidth + ev.clientX - startX));
        setWidth(w);
      };
      const onUp = () => {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
      };
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    },
    [setWidth, min, max]
  );

  return { width, onResizeStart };
}
