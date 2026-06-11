// Independent from activePageId so cmd/shift-click selection coexists with
// the currently open page. Clears automatically on view switch.

import { createContext, type ReactNode, useContext, useState } from "react";

import { computeRangeSelection } from "./selectionUtils";
import { useUI } from "./UIContext";

export interface SelectionContextValue {
  selectedPageIds: ReadonlySet<string>;
  /** Toggle a single page in/out of the selection (Cmd+Click). */
  togglePageSelection: (pageId: string) => void;
  /** Select a range from the last-clicked anchor to targetId using the visible list order. */
  setRangeSelection: (visibleIds: string[], targetId: string, anchorOverride?: string) => void;
  selectAll: (visibleIds: string[]) => void;
  clearSelection: () => void;
  /** The last-clicked page ID used as the anchor for Shift+Click range selection. */
  selectionAnchorId: string | null;
  /** Update the selection anchor (set on every click / cmd+click). */
  setSelectionAnchorId: (id: string | null) => void;
}

const SelectionContext = createContext<SelectionContextValue | null>(null);

export function SelectionProvider({ children }: { children: ReactNode }) {
  const { activePageId, activeViewId } = useUI();
  const [selectedPageIds, setSelectedPageIds] = useState<ReadonlySet<string>>(new Set());
  const [selectionAnchorId, setSelectionAnchorId] = useState<string | null>(null);

  // Reset selection when the active view changes. setState-during-render is
  // the React-recommended pattern for "adjust state when a prop changes" —
  // a wrapper around UIContext.setActiveViewId would couple the two contexts.
  const [prevActiveViewId, setPrevActiveViewId] = useState(activeViewId);
  if (prevActiveViewId !== activeViewId) {
    setPrevActiveViewId(activeViewId);
    setSelectedPageIds(new Set());
    setSelectionAnchorId(null);
  }

  function togglePageSelection(pageId: string) {
    setSelectedPageIds((prev) => {
      const next = new Set(prev);
      // First cmd+click: seed selection with the active page so it's included.
      if (next.size === 0 && activePageId && activePageId !== pageId) {
        next.add(activePageId);
      }
      if (next.has(pageId)) next.delete(pageId);
      else next.add(pageId);
      return next;
    });
    setSelectionAnchorId(pageId);
  }

  function setRangeSelection(visibleIds: string[], targetId: string, anchorOverride?: string) {
    const anchor = anchorOverride ?? selectionAnchorId;
    if (!anchor) {
      setSelectedPageIds(new Set([targetId]));
      setSelectionAnchorId(targetId);
      return;
    }
    setSelectedPageIds(computeRangeSelection(visibleIds, anchor, targetId));
  }

  function selectAll(visibleIds: string[]) {
    setSelectedPageIds(new Set(visibleIds));
  }

  function clearSelection() {
    setSelectedPageIds(new Set());
    setSelectionAnchorId(null);
  }

  const value: SelectionContextValue = {
    clearSelection,
    selectAll,
    selectedPageIds,
    selectionAnchorId,
    setRangeSelection,
    setSelectionAnchorId,
    togglePageSelection,
  };

  return <SelectionContext.Provider value={value}>{children}</SelectionContext.Provider>;
}

// eslint-disable-next-line react-refresh/only-export-components
export function useSelection(): SelectionContextValue {
  const ctx = useContext(SelectionContext);
  if (!ctx) throw new Error("useSelection must be used within <SelectionProvider>");
  return ctx;
}
