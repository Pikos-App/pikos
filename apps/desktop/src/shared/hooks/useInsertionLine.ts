import { useState } from "react";
import { useDndMonitor } from "@dnd-kit/core";

/**
 * Returns the id of the item *before which* the insertion line should render,
 * or `null` meaning "after the last item", or `undefined` meaning no line.
 *
 * Only activates when both the dragged item and the over item belong to the
 * provided `ids` list, so cross-list drags (e.g. page → folder) are ignored.
 */
export function useInsertionLine(ids: string[]): string | null | undefined {
  const [activeId, setActiveId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);

  useDndMonitor({
    onDragStart({ active }) {
      setActiveId(String(active.id));
      setOverId(null);
    },
    onDragOver({ over }) {
      setOverId(over ? String(over.id) : null);
    },
    onDragEnd() {
      setActiveId(null);
      setOverId(null);
    },
    onDragCancel() {
      setActiveId(null);
      setOverId(null);
    },
  });

  if (!activeId || !overId) return undefined;

  const activeIdx = ids.indexOf(activeId);
  const overIdx = ids.indexOf(overId);

  // One or both items not in this list — no line
  if (activeIdx === -1 || overIdx === -1 || activeIdx === overIdx) return undefined;

  if (activeIdx > overIdx) {
    // Dragging up: insert before the over item
    return overId;
  } else {
    // Dragging down: insert before the item after over (null = after last)
    return ids[overIdx + 1] ?? null;
  }
}
