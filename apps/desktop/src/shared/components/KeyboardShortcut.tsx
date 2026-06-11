// Platform-aware symbols — Mac: ⌘⇧C | Windows/Linux: Ctrl+Shift+C.
// Shared so tooltip display and keyboard registration use the same mappings.

import { IS_MACOS } from "@/shared/constants/platform";

const KEY_MAP_MAC: Record<string, string> = {
  alt: "⌥",
  arrowdown: "↓",
  arrowleft: "←",
  arrowright: "→",
  arrowup: "↑",
  backspace: "⌫",
  ctrl: "⌃",
  delete: "⌦",
  enter: "↵",
  escape: "Esc",
  mod: "⌘",
  shift: "⇧",
  space: "Space",
  tab: "⇥",
};

const KEY_MAP_OTHER: Record<string, string> = {
  alt: "Alt",
  arrowdown: "↓",
  arrowleft: "←",
  arrowright: "→",
  arrowup: "↑",
  backspace: "Backspace",
  ctrl: "Ctrl",
  delete: "Del",
  enter: "Enter",
  escape: "Esc",
  mod: "Ctrl",
  shift: "Shift",
  space: "Space",
  tab: "Tab",
};

function formatKey(key: string): string {
  const lower = key.toLowerCase();
  const map = IS_MACOS ? KEY_MAP_MAC : KEY_MAP_OTHER;
  return map[lower] ?? key.toUpperCase();
}

interface KeyboardShortcutProps {
  shortcut: string; // canonical format: "mod+shift+c"
}

export function KeyboardShortcut({ shortcut }: KeyboardShortcutProps) {
  const keys = shortcut.split("+").map(formatKey);

  return (
    <span className="inline-flex items-center gap-0.5">
      {keys.map((key, i) => (
        <kbd
          className="inline-flex h-4 min-w-4 items-center justify-center rounded border border-background/20 bg-background/10 px-0.5 font-mono text-[10px] leading-none"
          key={i}
        >
          {key}
        </kbd>
      ))}
    </span>
  );
}
