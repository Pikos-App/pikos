// Renders nothing; owns the delete-block combo for one block. The block mounts it on its popover's
// open state, not with the popover's body, which stays mounted through the close animation:
// opening a second block's popover then bound the pair twice, and the registry's first match, the
// closing one, deleted the wrong page.

import { useKeyboardShortcut } from "@/shared/keyboard/useKeyboard";

export function BlockDeleteShortcut({ onDelete }: { onDelete: () => void }) {
  useKeyboardShortcut("Mod+Backspace", onDelete, { scope: "modal" });
  // Overrides the OS line-delete inside the title input.
  useKeyboardShortcut("Mod+Shift+Backspace", onDelete, {
    allowInInputs: true,
    preventDefault: true,
    scope: "modal",
  });

  return null;
}
