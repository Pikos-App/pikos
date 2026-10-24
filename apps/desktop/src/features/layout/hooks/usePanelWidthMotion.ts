import { animate, type MotionValue, useMotionValue } from "framer-motion";
import { useLayoutEffect, useRef } from "react";

export const PANEL_SPRING = { damping: 35, stiffness: 350, type: "spring" as const };

/**
 * A panel's on-screen width that springs only when the panel opens or closes.
 *
 * Every other change jumps: the interface text size, a divider drag, a narrower
 * window. Springing a width the text size moved re-lays-out every panel each
 * frame on top of the document-wide restyle the size change already forces,
 * which is what made holding ⌘+ drop frames. Picking the transition during
 * render doesn't work: the compiler rejects reading a ref in render, and a
 * state copy of the previous size is discarded on React's first pass, so Motion
 * springs anyway.
 */
export function usePanelWidthMotion(width: number, hidden: boolean): MotionValue<number> {
  const shown = useMotionValue(hidden ? 0 : width);
  const lastHidden = useRef(hidden);

  useLayoutEffect(() => {
    const target = hidden ? 0 : width;
    const isToggle = lastHidden.current !== hidden;
    lastHidden.current = hidden;

    if (!isToggle) {
      shown.jump(target);
      return;
    }

    const controls = animate(shown, target, PANEL_SPRING);
    return () => controls.stop();
  }, [hidden, shown, width]);

  return shown;
}
