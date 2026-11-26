// One owner for the delete-block combo. The two popovers are mutually exclusive, but both
// registered the pair, and the registry resolves a duplicate by mount order.

import { useKeyboardShortcut } from "@/shared/keyboard/useKeyboard";

export function useBlockDeleteShortcut(onDelete: () => void) {
  useKeyboardShortcut("Mod+Backspace", onDelete, { scope: "modal" });
  // Overrides the OS line-delete inside the title input.
  useKeyboardShortcut("Mod+Shift+Backspace", onDelete, {
    allowInInputs: true,
    preventDefault: true,
    scope: "modal",
  });
}
