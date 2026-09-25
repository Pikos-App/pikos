// Renders nothing; owns the delete-page shortcuts.
//
// They sit above the middle column's view branch because they act on the active
// page, which outlives whichever panel the column is showing. Registered inside
// the page list they stopped working the moment the trash took the column, which
// is exactly when a user is most likely to reach for one.

import { useSelection } from "@/shared/context/SelectionContext";
import { useUI } from "@/shared/context/UIContext";
import { useKeyboardShortcut } from "@/shared/keyboard/useKeyboard";

import { usePageListContext } from "../PageListContext";

export function DeletePageShortcut() {
  const { activePage, completedPages, handleDeleteRequest, visiblePages } = usePageListContext();
  const { clearSelection, selectedPageIds } = useSelection();
  const { openDialog, settingsOpen } = useUI();

  function deleteSelectedOrActive() {
    if (selectedPageIds.size > 0) {
      const allPages = [...visiblePages, ...completedPages];
      for (const page of allPages.filter((p) => selectedPageIds.has(p.id))) {
        handleDeleteRequest(page);
      }
      clearSelection();
    } else if (activePage) {
      handleDeleteRequest(activePage);
    }
  }

  useKeyboardShortcut("Mod+Backspace", deleteSelectedOrActive, {
    group: "Navigation",
    label: "Delete page",
  });
  // Reaches inside text inputs and the editor, so a page can be deleted while
  // writing it. A dialog on top means the active page is not what the user has
  // in mind, so the gate keeps it from deleting one out from under them.
  useKeyboardShortcut("Mod+Shift+Backspace", deleteSelectedOrActive, {
    allowInInputs: true,
    group: "Navigation",
    label: "Delete page (works in text inputs)",
    preventDefault: true,
    when: () => openDialog === null && !settingsOpen,
  });

  return null;
}
