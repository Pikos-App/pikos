import { useDndMonitor } from "@dnd-kit/core";
import { useState } from "react";

/**
 * Returns the id of the item *before which* the insertion line renders, `null` for "after the last
 * item", or `undefined` for no line. Only active when the dragged and over items both belong to
 * `ids`, so cross-list drags (page → folder) are ignored.
 */
export function useInsertionLine(ids: string[]): string | null | undefined {
  const [activeId, setActiveId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);

  useDndMonitor({
    onDragCancel() {
      setActiveId(null);
      setOverId(null);
    },
    onDragEnd() {
      setActiveId(null);
      setOverId(null);
    },
    onDragOver({ over }) {
      setOverId(over ? String(over.id) : null);
    },
    onDragStart({ active }) {
      setActiveId(String(active.id));
      setOverId(null);
    },
  });

  if (!activeId || !overId) return undefined;

  const activeIdx = ids.indexOf(activeId);
  const overIdx = ids.indexOf(overId);

  if (activeIdx === -1 || overIdx === -1 || activeIdx === overIdx) return undefined;

  if (activeIdx > overIdx) {
    return overId;
  } else {
    return ids[overIdx + 1] ?? null;
  }
}
