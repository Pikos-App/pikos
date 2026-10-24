import { type AnimationEvent, useState } from "react";

/**
 * A row hidden while it was dragged fades back in wherever it lands, rather than
 * popping in. Opacity only: a reorder already moved the rows, and sliding them
 * would move what the cursor is over.
 */
export function useDropSettle(isDragging: boolean) {
  const [wasDragging, setWasDragging] = useState(isDragging);
  const [isSettling, setIsSettling] = useState(false);

  const dragJustEnded = wasDragging && !isDragging;
  if (isDragging !== wasDragging) {
    setWasDragging(isDragging);
    setIsSettling(dragJustEnded);
  }

  function onAnimationEnd(e: AnimationEvent) {
    // A child's animation, such as the tick scaling in, bubbles here too.
    const isOwnAnimation = e.target === e.currentTarget;
    if (isOwnAnimation) setIsSettling(false);
  }

  return { isSettling, onAnimationEnd };
}
