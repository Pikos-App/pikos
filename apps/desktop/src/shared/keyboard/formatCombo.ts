// Combo strings ("Mod+Shift+K") → the key tokens a UI renders as badges.
// Shared by the shortcuts settings page and the command palette so one combo
// never reads two ways in the same app.

import { IS_MACOS } from "@/shared/constants/platform";

const MOD = IS_MACOS ? "⌘" : "Ctrl";
const SHIFT = "⇧";
const ALT = IS_MACOS ? "⌥" : "Alt";

export function formatCombo(combo: string): string[] {
  return combo.split("+").map((part) => {
    switch (part.trim()) {
      case "Mod":
        return MOD;
      case "Shift":
        return SHIFT;
      case "Alt":
      case "Option":
        return ALT;
      case "Enter":
        return "↵";
      case "Tab":
        return "⇥";
      case "ArrowUp":
        return "↑";
      case "ArrowDown":
        return "↓";
      case "ArrowLeft":
        return "←";
      case "ArrowRight":
        return "→";
      case "\\":
        return "\\";
      case "Space":
        return "Space";
      case "Escape":
        return "Esc";
      default:
        return part.trim().toUpperCase();
    }
  });
}
