// Renders nothing; owns the export-page command. Mounted beside the delete shortcuts
// for the same reason: it acts on the active page, whichever panel has the column.

import { Keyboard } from "@/shared/keyboard/registry";
import { useKeyboardShortcut } from "@/shared/keyboard/useKeyboard";

import { useExportPage } from "../hooks/useExportPage";
import { usePageListContext } from "../PageListContext";

export function ExportPageShortcut() {
  const { activePage } = usePageListContext();
  const { exportPage } = useExportPage();

  useKeyboardShortcut(
    "Mod+Shift+E",
    () => {
      if (activePage) void exportPage(activePage);
    },
    {
      allowInInputs: true,
      group: "Navigation",
      label: "Export page as Markdown",
      preventDefault: true,
      when: () => Boolean(activePage) && !Keyboard.isModalOpen(),
    }
  );

  return null;
}
