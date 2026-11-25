import type { Modifier } from "@dnd-kit/core";
import { getEventCoordinates } from "@dnd-kit/utilities";

/** How far the ghost's corner sits below and right of the pointer, in px. */
const CURSOR_GAP = 12;

/**
 * Hangs a drag ghost below and right of the pointer. Held where the row was grabbed, it sits
 * under the pointer and covers the name of the folder it's about to drop on.
 */
export const besideCursor: Modifier = ({ activatorEvent, activeNodeRect, transform }) => {
  const start = activatorEvent && getEventCoordinates(activatorEvent);
  if (!start || !activeNodeRect) return transform;

  return {
    ...transform,
    x: start.x + transform.x + CURSOR_GAP - activeNodeRect.left,
    y: start.y + transform.y + CURSOR_GAP - activeNodeRect.top,
  };
};
