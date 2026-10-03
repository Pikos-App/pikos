// Renders nothing; owns the delete-page shortcuts.
//
// They sit above the middle column's view branch because they act on the active
// page, which outlives whichever panel the column is showing. Registered inside
// the page list they stopped working the moment the trash took the column, which
// is exactly when a user is most likely to reach for one.

import { useSelection } from "@/shared/context/SelectionContext";
import { Keyboard } from "@/shared/keyboard/registry";
import { useKeyboardShortcut } from "@/shared/keyboard/useKeyboard";

import { usePageListContext } from "../PageListContext";

export function DeletePageShortcut() {
  const { activePage, cached, completedPages, handleDeleteRequest, visiblePages } =
    usePageListContext();
  const { clearSelection, selectedPageIds } = useSelection();

  function deleteSelectedOrActive() {
    if (selectedPageIds.size > 0) {
      const loaded = [...visiblePages, ...completedPages].filter((p) => selectedPageIds.has(p.id));
      const held = new Set(loaded.map((p) => p.id));
      const missing = cached ? [...selectedPageIds].filter((id) => !held.has(id)) : [];
      for (const page of loaded) handleDeleteRequest(page);
      clearSelection();
      if (cached && missing.length > 0) {
        void cached.rows(missing).then((fetched) => {
          for (const page of fetched) handleDeleteRequest(page);
        });
      }
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
  // in mind, so the gate keeps it from deleting one out from under them. Any
  // dialog: a list of the known ones let the recurring gap dialog through.
  useKeyboardShortcut("Mod+Shift+Backspace", deleteSelectedOrActive, {
    allowInInputs: true,
    group: "Navigation",
    label: "Delete page (works in text inputs)",
    preventDefault: true,
    when: () => !Keyboard.isModalOpen(),
  });

  return null;
}
