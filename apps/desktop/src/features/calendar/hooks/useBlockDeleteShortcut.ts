// Delete-the-block, for whichever calendar popover is open.
//
// One owner for the combo rather than one per popover. The two popovers are
// mutually exclusive at every call site — a block is virtual or it is not — but
// they each registered the same pair, and the registry resolves a duplicate by
// mount order, which is nobody's decision. Registering here makes the choice
// once, and leaves the gate nothing to allowlist.

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
