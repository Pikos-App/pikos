# Multi-Select Page Items

## Overview

Add multi-selection to the page list with bulk actions: complete, delete, drag to folder/view, drag to calendar.

## Selection Model

- **State**: `selectedPageIds: Set<string>` in UIContext, independent of `activePageId`
- **Click**: clears selection, sets active page (unchanged)
- **Shift+Click**: range select from last-clicked to current item (in visible list order)
- **Cmd+Click**: toggle individual item in/out of selection
- **Escape**: clears selection
- **Cmd+A** (page list focused): select all visible pages
- Selection auto-clears on view change (`activeViewId` change)
- Selection auto-clears when the editor gains focus (clicking into content area)

### Visual Treatment

Selected items get a distinct style from the active item. Active = `bg-surface-selected`. Selected = TBD (ring, lighter bg, or accent border) — must be visually distinguishable when both active and selected.

### Last-Clicked Tracking

Shift+Click range select needs a `lastClickedPageId` ref to anchor the range. Updated on every click and cmd+click. Cleared when selection clears.

## Bulk Actions

### Complete All (shortcut TBD)

Iterate `selectedPageIds` in list order, call `togglePageStatus` for each. Clear selection after.

### Delete All (`Cmd+Shift+D`)

When selection is non-empty, `Cmd+Shift+D` deletes all selected pages instead of just the active page. Show confirmation dialog: "Delete N pages?" Clear selection after.

### Drag to Folder / Today / Inbox

- Dragging a selected item drags all selected items
- Dragging an unselected item behaves as single-drag (current behavior), clears selection
- Drag overlay shows count badge (e.g., "3 pages") when multi-dragging
- On drop: apply move/reorder to all selected pages in list order
- Clear selection after drop

## Calendar Drop Behavior

### Drop on All-Day Zone

All selected pages scheduled as all-day events for that day. They stack in the all-day row.

### Drop on Time Grid

Pages scheduled at the drop time, staggered +30min apart, no duration (point-in-time). Order follows visible list order (top-to-bottom in current view).

Example: drop 4 pages at 2:00pm -> 2:00, 2:30, 3:00, 3:30.

Single-item drag retains current behavior (drop at exact time with default duration).

## Files Affected

- `apps/desktop/src/shared/context/UIContext.tsx` — add `selectedPageIds`, `clearSelection`, `togglePageSelection`, `setRangeSelection`
- `apps/desktop/src/features/pages/components/PageListItem.tsx` — shift/cmd click handlers, selected visual state
- `apps/desktop/src/features/layout/components/PageListPanel.tsx` — Escape handler, Cmd+A handler
- `apps/desktop/src/features/layout/hooks/useThreePanelDnD.ts` — multi-drag logic
- `apps/desktop/src/features/layout/components/ThreePanelLayout.tsx` — DragOverlay multi-item preview
- Keyboard shortcut additions: bulk complete (TBD), extend Cmd+Shift+D

## Edge Cases

- Shift+Click across overdue/today sections in Today view: range covers visible items regardless of section
- Selecting completed pages: allowed (supports bulk delete of completed items)
- Selection persists across sort mode changes within same view
- Renaming a page while it's in a selection: rename takes priority, no multi-select interaction
- Dragging while renaming: already disabled by existing `isRenaming` check
